export type Passage = {
  id: string
  text: string
}

export type SearchResult = {
  passageId: string
  sentence: string
  score: number
}

export type SearchResponse = {
  results: SearchResult[]
}

export type SearchRequest = {
  query: string
  passages: Passage[]
}
