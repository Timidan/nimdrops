import { ApiError, NetworkError } from '../api'

export function closeFailureNotice(err: unknown, closeMayHaveReached = false): string {
  if (err instanceof ApiError) return err.message
  if (closeMayHaveReached) {
    return 'We could not confirm whether the close request reached NimDrops. Check the drop before trying again.'
  }
  if (err instanceof NetworkError) return 'We could not reach NimDrops. Check your connection and try again.'
  return 'Something went wrong before the drop could be closed. Try again.'
}
