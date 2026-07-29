import { createHash } from 'node:crypto'

export function openTriviaQuestionId(
  prompt: string,
  correctAnswer: string,
  incorrectAnswers: readonly string[],
): string {
  const options = [correctAnswer, ...incorrectAnswers].sort()
  const canonical = JSON.stringify([prompt, correctAnswer, options])
  return `otdb-${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12)}`
}
