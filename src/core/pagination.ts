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

/**
 * A pending page that is BOTH awaitable (`await list()` → CursorPage) and
 * async-iterable (`for await (const item of list())` → items across all pages).
 * Lets `list()` be used either way without the caller needing to await first.
 */
export class CursorPagePromise<T> implements PromiseLike<CursorPage<T>>, AsyncIterable<T> {
  private promise?: Promise<CursorPage<T>>;
  constructor(private readonly load: () => Promise<CursorPage<T>>) {}

  private get inner(): Promise<CursorPage<T>> {
    return (this.promise ??= this.load());
  }

  then<TResult1 = CursorPage<T>, TResult2 = never>(
    onfulfilled?: ((value: CursorPage<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.inner.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<CursorPage<T> | TResult> {
    return this.inner.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<CursorPage<T>> {
    return this.inner.finally(onfinally);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    const page = await this.inner;
    yield* page;
  }
}
