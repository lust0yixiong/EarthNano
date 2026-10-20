import { expect, it } from 'vitest'
import Ajv from 'ajv'
import schema from '../../../contracts/execution/schema.json'
import fixtures from '../../../contracts/execution/usage-fixtures.json'

it('validates shared usage fixtures without changing legacy unknown or explicit zero records', () => {
  const validate = new Ajv({ allErrors: true }).compile({
    ...schema,
    $ref: '#/definitions/ExecutionUsage'
  })
  for (const value of fixtures.valid) expect(validate(value), JSON.stringify(value)).toBe(true)
  for (const value of fixtures.invalid) expect(validate(value), JSON.stringify(value)).toBe(false)
})
