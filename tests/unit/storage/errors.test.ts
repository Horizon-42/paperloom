// 本地服务的错误按错误代码翻译；不认识的代码退回服务端原文
import { afterEach, describe, expect, it } from "vitest";
import { setLocaleForTest } from "@/i18n";
import { createStorageApi, StorageApiError } from "@/services/storage/api";
import { localServiceErrorFromBody, localServiceErrorText } from "@/services/storage/errors";

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("本地服务错误的文案", () => {
  afterEach(() => setLocaleForTest("zh"));

  it("中文：与服务端原文一致（带参数的直接用原文）", () => {
    expect(localServiceErrorText("conflict", 409, "文件夹中的数据已被另一个窗口更新")).toBe("文件夹中的数据已被另一个窗口更新");
    expect(localServiceErrorText("missing-header", 403)).toBe("缺少 X-PaperLens 请求头");
    expect(localServiceErrorText("invalid-revision", 400, "revision 应为 8", { revision: 7 })).toBe("revision 应为 8");
    expect(localServiceErrorText("http", 502)).toBe("本地服务返回 502");
  });

  it("英文：按错误代码翻译，参数取自响应体；未知代码退回原文", () => {
    setLocaleForTest("en");
    expect(localServiceErrorText("conflict", 409, "文件夹中的数据已被另一个窗口更新")).toBe("Folder data was updated by another window");
    expect(localServiceErrorText("too-large", 413, "文件过大")).toBe("The request or file is too large");
    expect(localServiceErrorText("invalid-revision", 400, "revision 应为 8", { revision: 7 })).toBe("Invalid revision: expected 8");
    expect(localServiceErrorText("internal", 500, "EACCES: permission denied")).toBe("Local service error: EACCES: permission denied");
    expect(localServiceErrorText("some-new-code", 400, "server text")).toBe("server text");
    expect(localServiceErrorText("constructor", 400)).toBe("Local service returned 400");
    expect(localServiceErrorFromBody(404, {})).toBe("Local service returned 404");
    expect(localServiceErrorFromBody(410, { error: "gone", message: "这个接口已停用" })).toMatch(/^This endpoint is no longer used/);
  });

  it("客户端抛出的 StorageApiError：message 是翻译后的文案，代码和服务端原文都保留", async () => {
    setLocaleForTest("en");
    const api = createStorageApi("/x", () => json(409, { error: "unreadable", message: "data/library.json 无法读取（可能已损坏），不能直接覆盖", revision: 0 }));
    const err = await api.putLibrary("{}", 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageApiError);
    const e = err as StorageApiError;
    expect(e.code).toBe("unreadable");
    expect(e.status).toBe(409);
    expect(e.message).toBe("data/library.json can't be read (it may be damaged) and won't be overwritten directly");
    expect(e.data.message).toBe("data/library.json 无法读取（可能已损坏），不能直接覆盖");
  });
});
