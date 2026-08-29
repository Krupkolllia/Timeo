/**
 * Как файл покидает телефон.
 *
 * Цель — iPhone 13 Pro, приложение запущено с домашнего экрана
 * (display: standalone): адресной строки нет, кнопки «назад» нет, видимого
 * менеджера загрузок нет. Про <a download> в этом режиме нельзя утверждать, что
 * он работает: атрибут поддерживается Safari с iOS 13, но в установленном PWA
 * разработчики годами сообщают, что нажатие не делает ничего, а blob-ссылки на
 * отдельных сборках iOS ломались целиком. Проверить это удалённо нельзя, а
 * «ничего не произошло» на скриншоте неотличимо от сломанной сборки.
 *
 * Поэтому путей два, и выбор делается на устройстве:
 *
 *  1. navigator.share с файлом — системная шторка «Поделиться», из которой файл
 *     кладётся в «Файлы», iCloud Drive или почту, то есть туда, где не
 *     разработчик найдёт его снова. Наличие проверяется через canShare с тем же
 *     самым файлом: поддержка ТЕКСТА в Safari есть с iOS 12.2, а файлов — нет.
 *  2. Если шторки нет — обычная ссылка со скачиванием.
 *
 * Исход возвращается вызывающему всегда и всегда именно исход, а не void:
 * экран обязан сказать, что произошло, включая отмену и отказ.
 */
export type DeliveryOutcome =
  | { kind: "shared" }
  | { kind: "downloaded" }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

// Partial<Navigator>: в типах DOM share и canShare объявлены обязательными, а
// на деле их может не быть вовсе — ровно это мы и проверяем.
type MaybeShareNavigator = Partial<Navigator>;

function makeFile(json: string, fileName: string): File | null {
  if (typeof File !== "function") return null;
  try {
    return new File([json], fileName, { type: "application/json" });
  } catch {
    return null;
  }
}

function download(json: string, fileName: string): DeliveryOutcome {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    // Ссылка должна быть в документе: Safari игнорирует click() на элементе,
    // которого нет в дереве.
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return { kind: "downloaded" };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    // Отзываем адрес не сразу, а после того, как браузер успел начать
    // скачивание: немедленный revokeObjectURL обрывает его в Safari.
    if (url !== null) {
      const revoked = url;
      setTimeout(() => URL.revokeObjectURL(revoked), 60_000);
    }
  }
}

export async function deliverBackupFile(json: string, fileName: string): Promise<DeliveryOutcome> {
  const nav: MaybeShareNavigator = typeof navigator === "undefined" ? {} : navigator;
  const file = makeFile(json, fileName);

  if (nav.share && nav.canShare && file && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: fileName });
      return { kind: "shared" };
    } catch (error) {
      // Отмена шторки — не ошибка, и предлагать после неё скачивание нельзя:
      // человек только что сказал «не надо».
      if (error instanceof Error && error.name === "AbortError") return { kind: "cancelled" };
      // Всё остальное (iOS отказывает в share без причины чаще, чем хотелось
      // бы) — повод попробовать второй путь, а не показать ошибку.
      return download(json, fileName);
    }
  }

  return download(json, fileName);
}

/**
 * Чтение выбранного файла текстом.
 *
 * FileReader, а не Blob.text(): второй короче, но появился в Safari позже, и
 * терять восстановление на старом телефоне ради одной строки нельзя — экран
 * импорта нужен ровно тогда, когда всё остальное уже потеряно. Заодно это
 * единственный способ прочитать файл в jsdom, где Blob.text() не реализован.
 */
export function readTextFile(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("FileReader"));
    reader.readAsText(file);
  });
}
