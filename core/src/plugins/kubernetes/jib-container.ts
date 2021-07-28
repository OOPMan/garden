/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import { mkdirp } from "fs-extra"
import { resolve } from "path"
import tar from "tar"
import { defaultBuildTimeout } from "../../config/module"
import { ConfigurationError, PluginError } from "../../exceptions"
import { GardenModule } from "../../types/module"
import { BuildModuleParams } from "../../types/plugin/module/build"
import { ModuleActionHandlers } from "../../types/plugin/plugin"
import { makeTempDir } from "../../util/fs"
import { containerHelpers } from "../container/helpers"
import { KubeApi } from "./api"
import { KubernetesProvider } from "./config"
import { buildkitDeploymentName, ensureBuildkit } from "./container/build/buildkit"
import {
  ensureUtilDeployment,
  syncToBuildSync,
  utilContainerName,
  utilDeploymentName,
  utilRsyncPort,
} from "./container/build/common"
import { loadToLocalK8s } from "./container/build/local"
import { containerHandlers } from "./container/handlers"
import { getNamespaceStatus } from "./namespace"
import { PodRunner } from "./run"
import { getRunningDeploymentPod, usingInClusterRegistry } from "./util"

export const jibContainerHandlers: Partial<ModuleActionHandlers> = {
  ...containerHandlers,

  // Note: Can't import the JibContainerModule type until we move the kubernetes plugin out of the core package
  async build(params: BuildModuleParams<GardenModule>) {
    const { ctx, log, module, base } = params

    // Build the tarball with the base handler
    module.spec.build.tarOnly = true
    module.spec.build.tarFormat = "oci"

    const baseResult = await base!(params)
    const { tarPath } = baseResult.details

    if (!tarPath) {
      throw new PluginError(`Expected details.tarPath from the jib-container build handler.`, { baseResult })
    }

    const provider = <KubernetesProvider>ctx.provider
    const buildMode = provider.config.buildMode

    if (buildMode === "local-docker" || buildMode === "cluster-docker") {
      if (buildMode === "cluster-docker") {
        log.warn(
          chalk.yellow(
            `The jib-container module type doesn't support the cluster-docker build mode, which has been deprecated. Falling back to local-docker.`
          )
        )
      }
      // Load the built tarball into the local docker daemon, and the local Kubernetes cluster (if needed)
      await containerHelpers.dockerCli({ cwd: module.buildPath, args: ["load", "--input", tarPath], log, ctx })
      await loadToLocalK8s(params)
      return baseResult
    }

    // Push to util or buildkit deployment on remote, and push to registry from there to make sure auth/access is
    // consistent with normal image pushes.
    const api = await KubeApi.factory(log, ctx, provider)
    const namespace = (await getNamespaceStatus({ log, ctx, provider })).namespaceName

    const tempDir = await makeTempDir()

    try {
      // Extract the tarball
      const extractPath = resolve(tempDir.path, module.name)
      await mkdirp(extractPath)
      log.debug(`Extracting built image tarball from ${tarPath} to ${extractPath}`)

      await tar.x({
        cwd: extractPath,
        file: tarPath,
      })

      let deploymentName: string

      // Make sure the sync target is up
      if (buildMode === "kaniko") {
        // Make sure the garden-util deployment is up
        await ensureUtilDeployment({
          ctx,
          provider,
          log,
          api,
          namespace,
        })
        deploymentName = utilDeploymentName
      } else if (buildMode === "cluster-buildkit") {
        // Make sure the buildkit deployment is up
        await ensureBuildkit({
          ctx,
          provider,
          log,
          api,
          namespace,
        })
        deploymentName = buildkitDeploymentName
      } else {
        throw new ConfigurationError(`Unexpected buildMode ${buildMode}`, { buildMode })
      }

      // Sync the archive to the remote
      const { dataPath } = await syncToBuildSync({
        ...params,
        api,
        namespace,
        deploymentName,
        rsyncPort: utilRsyncPort,
        sourcePath: extractPath,
      })

      const pushTimeout = module.build.timeout || defaultBuildTimeout

      const syncCommand = ["skopeo", `--command-timeout=${pushTimeout}s`, "copy", "--authfile", "/.docker/config.json"]

      if (usingInClusterRegistry(provider)) {
        syncCommand.push("--dest-tls-verify=false")
      }

      syncCommand.push("oci:" + dataPath, "docker://" + module.outputs["deployment-image-id"])

      log.setState(`Pushing image ${module.outputs["deployment-image-id"]} to registry`)

      const runner = new PodRunner({
        api,
        ctx,
        provider,
        namespace,
        pod: await getRunningDeploymentPod({
          api,
          deploymentName,
          namespace,
        }),
      })

      const { log: skopeoLog } = await runner.exec({
        log,
        command: ["sh", "-c", syncCommand.join(" ")],
        timeoutSec: pushTimeout + 5,
        containerName: utilContainerName,
        buffer: true,
      })

      log.debug(skopeoLog)
      log.setState(`Image ${module.outputs["deployment-image-id"]} built and pushed to registry`)

      return baseResult
    } finally {
      await tempDir.cleanup()
    }
  },
}
