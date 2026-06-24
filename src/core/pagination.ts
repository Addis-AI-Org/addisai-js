// Cursor-based auto-pagination. Returned objects are async-iterable so callers
// can `for await (const item of client.voice.clips.list())` across all pages,
// while still exposing the current page and cursor.

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
  limit: number | null;
}

export class CursorPage<T> implements AsyncIterable<T> {
  constructor(
    private readonly firstPage: Page<T>,
    private readonly fetchPage: (cursor: string) => Promise<Page<T>>,
  ) {}

  /** Items on the first page only. */
  get data(): T[] {
    return this.firstPage.data;
  }

  get nextCursor(): string | null {
    return this.firstPage.nextCursor;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let page = this.firstPage;
    while (true) {
      for (const item of page.data) yield item;
      if (!page.nextCursor) return;
      page = await this.fetchPage(page.nextCursor);
    }
  }
}
