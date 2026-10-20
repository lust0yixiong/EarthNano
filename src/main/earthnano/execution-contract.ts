import { createHash } from 'node:crypto'
import Ajv from 'ajv'
import schema from '../../../contracts/execution/schema.json'
import type { ExecutionRequest } from '../../shared/earthnano/execution-types'

const validator = new Ajv({ allErrors: true }).compile(schema)
const recordValidator = new Ajv({ allErrors: true }).compile({
  ...schema,
  $ref: '#/definitions/ExecutionRecord'
})
const eventValidator = new Ajv({ allErrors: true }).compile({
  ...schema,
  $ref: '#/definitions/ExecutionEvent'
})

export function validateEvent(value: unknown): void {
  if (!eventValidator(value)) {
    throw new ExecutionContractError('invalid-event', JSON.stringify(eventValidator.errors))
  }
}

export function validateRecord(value: unknown): void {
  if (!recordValidator(value)) {
    throw new ExecutionContractError('invalid-record', JSON.stringify(recordValidator.errors))
  }
  validateRequest((value as { request: unknown }).request)
}

export class ExecutionContractError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ExecutionContractError'
  }
}

export function validateRequest(value: unknown): asserts value is ExecutionRequest {
  if (!validator(value)) {
    throw new ExecutionContractError('invalid-request', JSON.stringify(validator.errors))
  }
  const request = value as ExecutionRequest
  if (
    request.origin.kind === 'optimization' &&
    (!request.origin.optimizationId || !request.origin.stageId)
  ) {
    throw new ExecutionContractError(
      'invalid-request',
      'Optimization requires optimizationId and stageId'
    )
  }
  if (request.origin.kind === 'optimization' && request.timeoutMs === 0) {
    throw new ExecutionContractError('invalid-request', 'Optimization requires a bounded deadline')
  }
  // The wire format uses Unicode scalar strings, safe integers and ASCII property names.
  // In particular reject lone UTF-16 surrogates rather than hashing replacement characters.
  const visit = (input: unknown): void => {
    if (
      typeof input === 'string' &&
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)
    ) {
      throw new ExecutionContractError('invalid-request', 'Invalid Unicode string')
    }
    if (input && typeof input === 'object') Object.values(input).forEach(visit)
  }
  visit(request)
}

export function requestDigest(request: ExecutionRequest): string {
  validateRequest(request)
  const canonical = (value: unknown): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, child]) => [key, canonical(child)])
        )
      : value
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(request)))
    .digest('hex')}`
}
