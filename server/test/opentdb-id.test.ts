import { describe, expect, it } from 'vitest'
import { openTriviaQuestionId } from '../spike/opentdb-id'

describe('openTriviaQuestionId', () => {
  it('does not depend on the order of the incorrect answers', () => {
    const first = openTriviaQuestionId('How many sides?', '7', ['4', '5', '9'])
    const second = openTriviaQuestionId('How many sides?', '7', ['9', '4', '5'])
    expect(first).toBe(second)
  })

  it('changes when a distractor changes', () => {
    const first = openTriviaQuestionId('How many sides?', '7', ['4', '5', '9'])
    const second = openTriviaQuestionId('How many sides?', '7', ['5', '6', '8'])
    expect(first).not.toBe(second)
  })

  it('changes when the answer key changes', () => {
    const first = openTriviaQuestionId('Pick one', 'A', ['B', 'C', 'D'])
    const second = openTriviaQuestionId('Pick one', 'B', ['A', 'C', 'D'])
    expect(first).not.toBe(second)
  })
})
