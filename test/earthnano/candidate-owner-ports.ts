import type { PersistentCandidateOwnersOptions } from '../../src/main/earthnano/persistent-candidate-owner'
import type { PrismaClient } from '@prisma/client'
import { ManagedFileVersionService } from '../../src/main/managed-file-versions/service'
import { ManagedFileIndexRepository } from '../../src/main/project-files/repository'
import { SessionPersistenceCoordinator } from '../../src/main/session-persistence/coordinator'
import { SessionProjectionRepository } from '../../src/main/session-persistence/projection'
import { SessionRepository } from '../../src/main/session-persistence/repository'
import { SettingsRepository } from '../../src/main/settings/repository'
import { UploadRepository } from '../../src/main/uploads/repository'

/** Explicit standalone test composition; production always supplies its original authority. */
export function createCandidateOwnerTestPorts(options: {
  dataRoot: string
  configRoot: string
  getClient(): Promise<PrismaClient>
  repository?: SessionRepository
}): Pick<PersistentCandidateOwnersOptions, 'settings' | 'sessionPersistence'> {
  const repository =
    options.repository ??
    new SessionRepository(
      options.configRoot,
      {},
      new SessionProjectionRepository(options.getClient)
    )
  const versions = new ManagedFileVersionService({
    storageRoot: options.dataRoot,
    getClient: options.getClient
  })
  const uploads = new UploadRepository(options.dataRoot, { getClient: options.getClient })
  const files = new ManagedFileIndexRepository(
    options.getClient,
    options.dataRoot,
    versions,
    uploads
  )
  return {
    settings: new SettingsRepository(options.configRoot),
    sessionPersistence: {
      repository,
      coordinator: new SessionPersistenceCoordinator(repository, files)
    }
  }
}
