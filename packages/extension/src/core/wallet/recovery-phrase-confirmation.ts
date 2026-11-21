import { wordlist } from '@scure/bip39/wordlists/english'

export interface VerificationWordOption {
  readonly optionId: number
  readonly word: string
}

type RandomIndex = (upperExclusive: number) => number

function assertUpperExclusive(upperExclusive: number): void {
  if (
    !Number.isSafeInteger(upperExclusive) ||
    upperExclusive <= 0 ||
    upperExclusive > 0x1_0000_0000
  ) {
    throw new Error('Random selection range must be a positive 32-bit integer')
  }
}

function readRandomIndex(randomIndex: RandomIndex, upperExclusive: number): number {
  const value = randomIndex(upperExclusive)
  if (!Number.isSafeInteger(value) || value < 0 || value >= upperExclusive) {
    throw new Error('Random selection returned an out-of-range index')
  }
  return value
}

export function secureRandomIndex(upperExclusive: number): number {
  assertUpperExclusive(upperExclusive)

  const uint32Range = 0x1_0000_0000
  const acceptanceLimit = uint32Range - (uint32Range % upperExclusive)
  const randomValue = new Uint32Array(1)

  do {
    crypto.getRandomValues(randomValue)
  } while (randomValue[0] >= acceptanceLimit)

  return randomValue[0] % upperExclusive
}

export function selectVerificationIndices(
  wordCount: number,
  selectionCount = 2,
  randomIndex: RandomIndex = secureRandomIndex
): number[] {
  if (
    !Number.isSafeInteger(wordCount) ||
    !Number.isSafeInteger(selectionCount) ||
    selectionCount <= 0 ||
    wordCount < selectionCount
  ) {
    throw new Error('Recovery phrase verification range is invalid')
  }

  const candidates = Array.from({ length: wordCount }, (_, index) => index)
  for (let position = 0; position < selectionCount; position += 1) {
    const swapIndex = position + readRandomIndex(randomIndex, candidates.length - position)
    const candidate = candidates[position]
    candidates[position] = candidates[swapIndex]
    candidates[swapIndex] = candidate
  }

  return candidates.slice(0, selectionCount).sort((left, right) => left - right)
}

export function selectDifferentVerificationIndices(
  wordCount: number,
  previousIndices: readonly number[],
  selectionCount = 2,
  randomIndex: RandomIndex = secureRandomIndex
): number[] {
  const selected = selectVerificationIndices(wordCount, selectionCount, randomIndex)
  if (
    previousIndices.length !== selected.length ||
    selected.some((index, position) => index !== previousIndices[position])
  ) {
    return selected
  }

  const replacement = Array.from({ length: wordCount }, (_, index) => index).find(
    index => !selected.includes(index)
  )
  if (replacement === undefined) return selected

  return [...selected.slice(0, -1), replacement].sort((left, right) => left - right)
}

export function shuffleVerificationWordOptions(
  words: readonly string[],
  verificationIndices: readonly number[],
  randomIndex: RandomIndex = secureRandomIndex
): VerificationWordOption[] {
  if (
    verificationIndices.length !== 2 ||
    verificationIndices.some(
      index => !Number.isSafeInteger(index) || index < 0 || index >= words.length
    ) ||
    verificationIndices[0] === verificationIndices[1]
  ) {
    throw new Error('Recovery phrase verification range is invalid')
  }

  const phraseWords = new Set(words)
  const distractors = wordlist.filter(word => !phraseWords.has(word))
  const options: VerificationWordOption[] = verificationIndices.map(optionId => ({
    optionId,
    word: words[optionId]
  }))
  const distractorCount = words.length - verificationIndices.length
  for (let index = 0; index < distractorCount; index += 1) {
    const swapIndex = index + readRandomIndex(randomIndex, distractors.length - index)
    const word = distractors[index]
    distractors[index] = distractors[swapIndex]
    distractors[swapIndex] = word
    options.push({ optionId: -index - 1, word: distractors[index] })
  }

  for (let index = options.length - 1; index > 0; index -= 1) {
    const swapIndex = readRandomIndex(randomIndex, index + 1)
    const option = options[index]
    options[index] = options[swapIndex]
    options[swapIndex] = option
  }

  return options
}
