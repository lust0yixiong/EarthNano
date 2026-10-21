import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false } }))
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createResearchWorkflowFixture } from '../../../test/earthnano/research-workflow'
import { SessionRepository, loadSessionMutationAuthority } from '../session-persistence/repository'
import { ReviewRepository } from '../reviewer/repository'
import { NotebookRunRepository } from '../notebook/repository'

configureTestRuntimeMetadata()

it.skipIf(!process.env.EARTHNANO_RESEARCH_PYTHON)(
  'executes the shipped research MCP workflow, pins its Python output, reviews it and reopens original owners',
  async () => {
    const fixture = await createResearchWorkflowFixture()
    try {
      // Notebook must use the registered immutable upload, not this later changed workspace file.
      await writeFile(join(fixture.workspace, 'measurements.csv'), 'sample,value\nchanged,999\n')
      const session = await fixture.execute()
      expect(fixture.reply()).toContain('Mean: 4.00')
      expect(session.artifacts).toHaveLength(1)
      const artifact = session.artifacts![0]
      expect(artifact.name).toBe('research-results.md')
      expect(artifact.versionId).toBeTruthy()
      const run = (
        await new NotebookRunRepository(fixture.root).readSessionRuns(
          fixture.projectId,
          fixture.sessionId
        )
      ).find((entry) => entry.kernelKind === 'python')!
      expect(run).toMatchObject({
        status: 'completed',
        kernelDispatched: true,
        promptMessageId: fixture.promptMessageId
      })
      expect(run.inputFiles?.[0]).toMatchObject({
        sourceKind: 'upload-version',
        inputFileVersionId: fixture.inputVersionId,
        filename: 'measurements.csv'
      })
      expect(
        run.workingFiles.some((file) => file.relativePath.endsWith('research-results.md'))
      ).toBe(true)
      const version = await fixture.client.artifactVersion.findUniqueOrThrow({
        where: { id: artifact.versionId! }
      })
      expect(version.state).toBe('finalized')
      expect(version.executionSnapshotJson).toContain(run.runId)
      // Reviewer must read published Version bytes, not the mutable Notebook working copy.
      await writeFile(fixture.reportPath, '# Mutable working copy\nMean: 999.00\n')
      const review = await fixture.review()
      expect(review.result.review.errorMessage).toBeUndefined()
      expect(review.result.review).toMatchObject({ lifecycle: 'complete', outcome: 'pass' })
      expect(JSON.stringify(review.readContent)).toContain('Mean: 4.00')
      expect(JSON.stringify(review.readTrace)).toContain(run.runId)
      const sourceIsAdmitted =
        review.result.review.scope.sourceDocumentVersionIds?.includes(fixture.inputVersionId) ===
        true
      expect(review.readSource).toMatchObject({ isError: !sourceIsAdmitted })
      if (sourceIsAdmitted) expect(JSON.stringify(review.readSource)).not.toContain('999')
      else {
        expect(run.inputFiles?.[0].accessEvidence).not.toBe('file-evidence')
        expect(JSON.parse(version.executionSnapshotJson!).inputFiles).toEqual([])
      }
      expect(version.producerRunId).toBe(run.runId)
      expect(review.result.review.scope.artifactVersionIds).toEqual([artifact.versionId])
      const records = await fixture.records()
      expect(records.map((record) => record.request.role).sort()).toEqual(['reviewer', 'task'])
      expect(new Set(records.map((record) => record.executionId)).size).toBe(2)
      for (const record of records) {
        expect(record.request.origin).toMatchObject({
          sessionId: fixture.sessionId,
          promptMessageId: fixture.promptMessageId
        })
      }
      expect(
        records.every((record) => record.phase === 'completed' && record.cleanup === 'confirmed')
      ).toBe(true)
      const reopened = await loadSessionMutationAuthority(
        new SessionRepository(fixture.root),
        fixture.projectId,
        fixture.sessionId
      )
      expect(reopened.status).toBe('found')
      if (reopened.status !== 'found') throw new Error('Session was not reopened')
      expect(reopened.session.artifacts?.[0].versionId).toBe(artifact.versionId)
      const reviews = await new ReviewRepository(async () => fixture.client, {
        snapshotStorageRoot: fixture.root
      }).getReviewsForProjectSession(fixture.projectId, fixture.sessionId)
      expect(reviews[0].id).toBe(review.result.review.id)
      const lease = await fixture.versions.openVersion(
        { source: 'artifact', projectId: fixture.projectId, fileId: artifact.artifactId! },
        artifact.versionId!
      )
      try {
        expect(await readFile(lease.path, 'utf8')).toContain('Mean: 4.00')
        await lease.verifyUnchanged()
      } finally {
        await lease.close()
      }
    } finally {
      await fixture.dispose()
    }
  },
  120_000
)
