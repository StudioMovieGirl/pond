import { PrefsSchema, type SaveFile, type Source } from "@pond/schema/db";
import { describe, expect, it, vi } from "vitest";
import type { WriteFileArgs } from "./apply";
import { hasWarcArchive, runArchivePage } from "./archive-page";

const preview: SaveFile = {
  kind: "image",
  path: "preview.jpg",
  sha256: "abc",
  size: 4,
};

function setup(
  autoArchive: boolean,
  origin: { source: Source; url: string } = {
    source: "web",
    url: "https://example.com/notes",
  },
) {
  const save = {
    ...origin,
    title: "Notes",
    description: "A short page",
    mediaUrl: "https://example.com/preview.jpg",
    files: [preview],
  };
  const readSave = vi.fn(async () => save);
  const autoArchivePages = vi.fn(async () => autoArchive);
  const crawlSite = vi.fn(async (_rootUrl: URL, _scope: string) => ({
    pages: [{ url: save.url, title: save.title }],
    warcBytes: Buffer.from("warc"),
    authWalled: false,
  }));
  const persistArchive = vi.fn(
    async (_saveId: string, files: WriteFileArgs[]) => {
      save.files = [
        ...save.files,
        ...files.map((file) => ({
          kind: file.kind,
          path: file.filename,
          sha256: "archived",
          size: file.bytes?.byteLength ?? 0,
        })),
      ];
    },
  );
  const writePageCover = vi.fn(
    async (_saveId: string, _rootUrl: URL, _signal: AbortSignal) => {
      save.files = [
        ...save.files,
        {
          kind: "thumbnail",
          path: "page-cover.webp",
          sha256: "cover",
          size: 128,
        },
      ];
    },
  );
  const runtime = {
    readSave,
    autoArchive: autoArchivePages,
    crawlSite,
    persistArchive,
    writePageCover,
  };
  return {
    save,
    readSave,
    autoArchivePages,
    crawlSite,
    persistArchive,
    writePageCover,
    runtime,
  };
}

const ctx = { signal: new AbortController().signal };

describe("archive_page automatic archive", () => {
  it("defaults to archiving so existing libraries keep today's behavior", () => {
    expect(PrefsSchema.parse({}).storage.autoArchive).toBe(true);
    expect(
      PrefsSchema.parse({ storage: { guardsEnabled: true } }).storage
        .autoArchive,
    ).toBe(true);
    expect(
      PrefsSchema.parse({ storage: { autoArchive: false } }).storage
        .autoArchive,
    ).toBe(false);
  });

  it("writes a cover and an archive when automatic archiving is on", async () => {
    const { save, crawlSite, persistArchive, writePageCover, runtime } =
      setup(true);

    await runArchivePage("save-1", {}, ctx, runtime);

    expect(writePageCover).toHaveBeenCalledOnce();
    expect(crawlSite).toHaveBeenCalledOnce();
    expect(persistArchive).toHaveBeenCalledOnce();
    expect(hasWarcArchive(save.files)).toBe(true);
    expect(save.files.map((file) => file.path)).toContain("page-cover.webp");
    expect(save.files.map((file) => file.path)).toContain("preview.jpg");
  });

  it("writes a cover even when automatic archiving is off", async () => {
    const {
      save,
      autoArchivePages,
      crawlSite,
      persistArchive,
      writePageCover,
      runtime,
    } = setup(false);

    await runArchivePage("save-1", {}, ctx, runtime);

    expect(autoArchivePages).toHaveBeenCalled();
    expect(writePageCover).toHaveBeenCalledOnce();
    expect(crawlSite).not.toHaveBeenCalled();
    expect(persistArchive).not.toHaveBeenCalled();
    expect(hasWarcArchive(save.files)).toBe(false);
    expect(save.files.map((file) => file.path)).toContain("page-cover.webp");
    expect(save).toMatchObject({
      title: "Notes",
      description: "A short page",
      mediaUrl: "https://example.com/preview.jpg",
    });
  });

  it("writes a cover before a login wall, and still finishes without an archive", async () => {
    const { save, crawlSite, persistArchive, writePageCover, runtime } =
      setup(true);
    crawlSite.mockResolvedValueOnce({
      pages: [],
      warcBytes: Buffer.alloc(0),
      authWalled: true,
    });

    await runArchivePage("save-1", {}, ctx, runtime);

    expect(writePageCover).toHaveBeenCalledOnce();
    expect(persistArchive).not.toHaveBeenCalled();
    expect(hasWarcArchive(save.files)).toBe(false);
    expect(save.files.map((file) => file.path)).toContain("page-cover.webp");
    expect(save.files.map((file) => file.path)).toContain("preview.jpg");
  });

  it("retries when a crawl captures no page and no login wall explains it", async () => {
    const { crawlSite, persistArchive, runtime } = setup(true);
    crawlSite.mockResolvedValueOnce({
      pages: [],
      warcBytes: Buffer.alloc(0),
      authWalled: false,
    });

    await expect(runArchivePage("save-1", {}, ctx, runtime)).rejects.toThrow(
      "no pages captured",
    );
    expect(persistArchive).not.toHaveBeenCalled();
  });

  it("still archives a site when asked, with automatic archiving off", async () => {
    const { save, crawlSite, persistArchive, runtime } = setup(false);

    await runArchivePage("save-1", { scope: "site" }, ctx, runtime);

    expect(crawlSite).toHaveBeenCalledOnce();
    expect(persistArchive).toHaveBeenCalledOnce();
    expect(hasWarcArchive(save.files)).toBe(true);
  });
});

describe("archive_page for Are.na saves", () => {
  it("archives the page an Are.na Link block points at", async () => {
    const { save, crawlSite, runtime } = setup(true, {
      source: "arena",
      url: "https://en.wikipedia.org/wiki/Community_Memory",
    });

    await runArchivePage("save-1", {}, ctx, runtime);

    expect(
      crawlSite.mock.calls.map(([rootUrl, scope]) => [rootUrl.href, scope]),
    ).toEqual([["https://en.wikipedia.org/wiki/Community_Memory", "page"]]);
    expect(hasWarcArchive(save.files)).toBe(true);
  });

  it("leaves Are.na blocks that still point at are.na alone", async () => {
    const { save, crawlSite, persistArchive, runtime } = setup(true, {
      source: "arena",
      url: "https://www.are.na/block/9613792",
    });

    await runArchivePage("save-1", { scope: "site" }, ctx, runtime);

    expect(crawlSite).not.toHaveBeenCalled();
    expect(persistArchive).not.toHaveBeenCalled();
    expect(hasWarcArchive(save.files)).toBe(false);
  });
});
