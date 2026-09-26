export class SearchFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchFailure'
  }
}
