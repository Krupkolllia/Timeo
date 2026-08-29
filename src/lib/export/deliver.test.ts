import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverBackupFile } from "@/lib/export/deliver";

const JSON_TEXT = '{"schema_version":1}';

interface NavigatorPatch {
  share?: (data?: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
}

function patchNavigator(patch: NavigatorPatch) {
  const original = { share: (navigator as NavigatorPatch).share, canShare: (navigator as NavigatorPatch).canShare };
  Object.assign(navigator, patch);
  return () => {
    Object.assign(navigator, original);
    if (original.share === undefined) delete (navigator as NavigatorPatch).share;
    if (original.canShare === undefined) delete (navigator as NavigatorPatch).canShare;
  };
}

const restores: (() => void)[] = [];

afterEach(() => {
  clicked.length = 0;
  while (restores.length) restores.pop()?.();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function stubObjectUrl() {
  // jsdom не реализует createObjectURL вовсе — без заглушки путь скачивания
  // упал бы не на том, что мы проверяем.
  URL.createObjectURL = vi.fn(() => "blob:timeo");
  URL.revokeObjectURL = vi.fn();
  // И не реализует переход по ссылке: настоящий click() с download ничего не
  // навигирует, а jsdom пишет в stderr «Not implemented: navigation» на каждый
  // вызов. Возвращаем сам вызов, чтобы было что проверить.
  return vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download, inDocument: this.isConnected });
  });
}

const clicked: { href: string; download: string; inDocument: boolean }[] = [];

describe("deliverBackupFile", () => {
  it("шторка «Поделиться» — основной путь на iPhone", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    restores.push(patchNavigator({ share, canShare: () => true }));

    const outcome = await deliverBackupFile(JSON_TEXT, "timeo-2026-08-29.json");

    expect(outcome).toEqual({ kind: "shared" });
    const shared = share.mock.calls[0][0] as { files: File[] };
    expect(shared.files[0].name).toBe("timeo-2026-08-29.json");
    expect(shared.files[0].type).toBe("application/json");
  });

  it("шторка есть, но файлы она не умеет — уходим на скачивание", async () => {
    stubObjectUrl();
    const share = vi.fn();
    // Ровно поведение Safari до iOS 15: share есть (текстом делиться можно),
    // canShare с файлом отвечает false.
    restores.push(patchNavigator({ share, canShare: () => false }));

    const outcome = await deliverBackupFile(JSON_TEXT, "timeo.json");

    expect(outcome).toEqual({ kind: "downloaded" });
    expect(share).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalled();
    // Safari игнорирует click() на элементе вне дерева документа.
    expect(clicked.at(-1)).toEqual({ href: "blob:timeo", download: "timeo.json", inDocument: true });
  });

  it("шторки нет вовсе — скачивание", async () => {
    stubObjectUrl();
    restores.push(patchNavigator({}));
    delete (navigator as NavigatorPatch).share;
    delete (navigator as NavigatorPatch).canShare;

    expect(await deliverBackupFile(JSON_TEXT, "timeo.json")).toEqual({ kind: "downloaded" });
  });

  it("отмена шторки — это отмена, а не ошибка и не скачивание", async () => {
    stubObjectUrl();
    const abort = new Error("cancelled");
    abort.name = "AbortError";
    restores.push(patchNavigator({ share: vi.fn().mockRejectedValue(abort), canShare: () => true }));

    expect(await deliverBackupFile(JSON_TEXT, "timeo.json")).toEqual({ kind: "cancelled" });
    // Человек только что сказал «не надо» — навязывать второй путь нельзя.
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("отказ шторки не по вине пользователя — пробуем скачивание", async () => {
    stubObjectUrl();
    restores.push(patchNavigator({ share: vi.fn().mockRejectedValue(new Error("NotAllowedError")), canShare: () => true }));

    expect(await deliverBackupFile(JSON_TEXT, "timeo.json")).toEqual({ kind: "downloaded" });
  });

  it("не сработало ничего — исход виден, а не проглочен", async () => {
    restores.push(patchNavigator({}));
    delete (navigator as NavigatorPatch).share;
    URL.createObjectURL = vi.fn(() => {
      throw new Error("blob запрещён");
    });

    const outcome = await deliverBackupFile(JSON_TEXT, "timeo.json");

    // «Ничего не произошло» на скриншоте неотличимо от сломанной сборки —
    // поэтому у отказа обязан быть текст.
    expect(outcome).toEqual({ kind: "failed", message: "blob запрещён" });
  });

  it("адрес blob отзывается не сразу: немедленный revoke обрывает скачивание в Safari", async () => {
    vi.useFakeTimers();
    stubObjectUrl();
    restores.push(patchNavigator({}));
    delete (navigator as NavigatorPatch).share;

    await deliverBackupFile(JSON_TEXT, "timeo.json");

    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:timeo");
  });
});
