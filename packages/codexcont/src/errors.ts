import { Data } from 'effect'

export class StreamFailure extends Data.TaggedError('StreamFailure')<{
  readonly cause: unknown
}> {}
