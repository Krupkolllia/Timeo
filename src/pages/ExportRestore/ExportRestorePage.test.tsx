import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { db } from "@/db/db";
import { getLocalUserId } from "@/db/localUser";
import { ExportRestorePage } from "@/pages/ExportRestore/ExportRestorePage";
import { serializeBackup, type BackupFile } from "@/lib/export/backup";
import { readTextFile } from "@/lib/export/deliver";
import { ru } from "@/i18n/ru";
import { makeDayType, makeEntry, makeHoliday, makePeriod, makeSettings, resetDb } from "@/test/factories";

const userId = getLocalUserId();

interface NavigatorPatch {
  share?: (data?: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
}

const shared: ShareData[] = [];

function stubShare(impl: (data?: ShareData) => Promise<void> = () => Promise.resolve()) {
  Object.assign(navigator, {
    canShare: () => true,
    share: (data?: ShareData) => {
      shared.push(data ?? {});
      return impl(data);
    },
  });
}

function clearShare() {
  delete (navigator as NavigatorPatch).share;
  delete (navigator as NavigatorPatch).canShare;
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderPage(initialEntry = "/settings/export") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/settings/export" element={<ExportRestorePage />} />
        <Route path="*" element={<span data-testid="elsewhere" />} />
      </Routes>
    </MemoryRouter>,
  );
}

function currentLocation(): string {
  return screen.getByTestId("location").textContent ?? "";
}

async function seed() {
  await db.settings.add(makeSettings({ user_id: userId, id: "s-local", seeded_holiday_years: [2026] }));
  await db.day_types.add(makeDayType({ user_id: userId }));
  await db.periods.add(makePeriod({ user_id: userId }));
  await db.entries.add(makeEntry({ user_id: userId, amount: 399.59999999999997 }));
  await db.holidays.add(makeHoliday({ user_id: userId }));
}

function fileFromText(text: string, name = "timeo.json"): File {
  return new File([text], name, { type: "application/json" });
}

function validBackup(): BackupFile {
  return {
    schema_version: 1,
    exported_at: "2026-08-29T10:00:00.000Z",
    app_version: "0.1.7",
    settings: makeSettings({ id: "s-file", user_id: "phone-2" }),
    periods: [makePeriod({ id: "p-file", year: 2026, month: 7, user_id: "phone-2" })],
    day_types: [makeDayType({ id: "dt-file", user_id: "phone-2" })],
    entries: [makeEntry({ id: "e-file", day_type_id: "dt-file", date: "2026-07-10", user_id: "phone-2" })],
    holidays: [makeHoliday({ id: "h-file", user_id: "phone-2" })],
  };
}

async function chooseFile(file: File) {
  const input = screen.getByLabelText(ru.backup.chooseFile);
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(async () => {
  shared.length = 0;
  await resetDb();
  stubShare();
});

afterEach(() => {
  clearShare();
  vi.restoreAllMocks();
});

describe("ExportRestorePage — сохранение копии (раздел 8.8)", () => {
  it("отдаёт файл в шторку «Поделиться» и говорит, что произошло", async () => {
    await seed();
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: ru.backup.exportAction }));

    expect(await screen.findByText(ru.backup.statusShared)).toBeInTheDocument();
    const files = (shared[0] as { files?: File[] }).files ?? [];
    expect(files[0].name).toMatch(/^timeo-\d{4}-\d{2}-\d{2}\.json$/);
    // Blob.text() в jsdom не реализован — читаем тем же способом, что и экран.
    const parsed = JSON.parse(await readTextFile(files[0])) as BackupFile;
    expect(parsed.schema_version).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    // Float-хвост уходит в файл как есть (раздел 5.4.1).
    expect(parsed.entries[0].amount).toBe(399.59999999999997);
  });

  it("отмена шторки видна на экране и не выдаётся за успех", async () => {
    await seed();
    const abort = new Error("cancelled");
    abort.name = "AbortError";
    stubShare(() => Promise.reject(abort));
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: ru.backup.exportAction }));

    expect(await screen.findByText(ru.backup.statusCancelled)).toBeInTheDocument();
  });

  it("отказ виден с текстом ошибки, а не молча", async () => {
    await seed();
    clearShare();
    URL.createObjectURL = vi.fn(() => {
      throw new Error("blob запрещён");
    });
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: ru.backup.exportAction }));

    expect(await screen.findByText(/blob запрещён/)).toBeInTheDocument();
  });
});

describe("ExportRestorePage — восстановление", () => {
  it("показывает содержимое файла до всякой записи в базу", async () => {
    await seed();
    renderPage();

    await chooseFile(fileFromText(serializeBackup(validBackup())));

    expect(await screen.findByText(/1 периодов/)).toBeInTheDocument();
    // Ни одной строки ещё не записано (инвариант 49): выбор файла — это не импорт.
    expect(await db.periods.count()).toBe(1);
    expect(await db.entries.count()).toBe(1);
  });

  it("«добавить недостающее» не трогает существующие строки", async () => {
    await seed();
    renderPage();

    await chooseFile(fileFromText(serializeBackup(validBackup())));
    fireEvent.click(await screen.findByRole("button", { name: ru.backup.modeMerge }));

    expect(await screen.findByText(ru.backup.importedTitle)).toBeInTheDocument();
    await waitFor(async () => {
      expect(await db.periods.count()).toBe(2);
    });
    expect((await db.day_types.get("dt-hourly"))?.name).toBe("Рабочий день");
    expect((await db.entries.get("e-file"))?.user_id).toBe(userId);
  });

  it("«заменить всё» требует подтверждения и без него ничего не делает (инвариант 56)", async () => {
    await seed();
    renderPage();

    await chooseFile(fileFromText(serializeBackup(validBackup())));
    fireEvent.click(await screen.findByRole("button", { name: ru.backup.modeReplace }));

    expect(await screen.findByText(ru.backup.replaceConfirmTitle)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: ru.backup.cancel }));

    await waitFor(() => expect(screen.queryByText(ru.backup.replaceConfirmTitle)).not.toBeInTheDocument());
    expect(await db.periods.get("p-2026-08")).toBeTruthy();
    expect(await db.entries.get("e-1")).toBeTruthy();
  });

  it("после подтверждения замены в базе остаётся только содержимое файла", async () => {
    await seed();
    renderPage();

    await chooseFile(fileFromText(serializeBackup(validBackup())));
    fireEvent.click(await screen.findByRole("button", { name: ru.backup.modeReplace }));
    fireEvent.click(await screen.findByRole("button", { name: ru.backup.replaceConfirmAction }));

    expect(await screen.findByText(ru.backup.importedTitle)).toBeInTheDocument();
    await waitFor(async () => {
      expect(await db.entries.get("e-1")).toBeUndefined();
    });
    expect(await db.entries.get("e-file")).toBeTruthy();
    expect(await db.periods.count()).toBe(1);
  });

  it("повреждённый файл не меняет данные и объясняет отказ", async () => {
    await seed();
    renderPage();

    await chooseFile(fileFromText(serializeBackup(validBackup()).slice(0, 80)));

    expect(await screen.findByText(ru.backup.errorInvalidJson)).toBeInTheDocument();
    // Кнопок импорта нет вовсе: применять нечего.
    expect(screen.queryByRole("button", { name: ru.backup.modeMerge })).not.toBeInTheDocument();
    expect(await db.entries.count()).toBe(1);
  });

  it("файл более новой версии отвергается с понятным текстом (инвариант 48)", async () => {
    await seed();
    renderPage();

    await chooseFile(fileFromText(JSON.stringify({ ...validBackup(), schema_version: 99 })));

    expect(await screen.findByText(ru.backup.errorUnsupportedVersion)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ru.backup.modeMerge })).not.toBeInTheDocument();
  });

  it("чужой JSON — это не резервная копия", async () => {
    await seed();
    renderPage();

    await chooseFile(fileFromText(JSON.stringify({ shopping: ["хлеб"] })));

    expect(await screen.findByText(ru.backup.errorNotBackup)).toBeInTheDocument();
  });

  it("файл, испорченный на последней записи, называет таблицу и оставляет базу как была", async () => {
    await seed();
    renderPage();

    const backup = validBackup();
    const broken = JSON.stringify({
      ...backup,
      entries: [...backup.entries, { ...makeEntry({ id: "e-bad" }), amount: "много" }],
    });
    await chooseFile(fileFromText(broken));

    expect(await screen.findByText(/entries/)).toBeInTheDocument();
    expect(await db.entries.count()).toBe(1);
  });

  it("осиротевшие записи показаны отдельной строкой, а не спрятаны (инвариант 36)", async () => {
    await seed();
    renderPage();

    const backup = validBackup();
    await chooseFile(
      fileFromText(
        JSON.stringify({
          ...backup,
          day_types: [],
          entries: [makeEntry({ id: "e-orphan", day_type_id: "dt-vanished", user_id: "phone-2" })],
        }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: ru.backup.modeMerge }));

    expect(await screen.findByText(new RegExp(ru.backup.importedRecovered))).toBeInTheDocument();
  });

  it("после импорта тот же файл не предлагается применить повторно", async () => {
    await seed();
    renderPage();

    await chooseFile(fileFromText(serializeBackup(validBackup())));
    fireEvent.click(await screen.findByRole("button", { name: ru.backup.modeMerge }));

    expect(await screen.findByText(ru.backup.importedTitle)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ru.backup.modeMerge })).not.toBeInTheDocument();
  });
});

describe("ExportRestorePage — навигация", () => {
  it("«назад» возвращает по адресу из return=", async () => {
    await seed();
    renderPage("/settings/export?return=%2Fperiod%3Fyear%3D2026%26month%3D8");

    fireEvent.click(screen.getByRole("button", { name: ru.backup.back }));

    expect(currentLocation()).toBe("/period?year=2026&month=8");
  });

  it("экран открывается и на пустой базе — именно в этом состоянии восстанавливают", async () => {
    renderPage();

    // Ни настроек, ни периодов: экран обязан работать, иначе восстановиться
    // после очистки хранилища было бы нечем.
    expect(screen.getByRole("button", { name: ru.backup.exportAction })).toBeInTheDocument();
    expect(screen.getByLabelText(ru.backup.chooseFile)).toBeInTheDocument();
  });

  it("на пустой базе импорт восстанавливает всё содержимое файла", async () => {
    renderPage();

    await chooseFile(fileFromText(serializeBackup(validBackup())));
    fireEvent.click(await screen.findByRole("button", { name: ru.backup.modeMerge }));

    expect(await screen.findByText(ru.backup.importedTitle)).toBeInTheDocument();
    await waitFor(async () => {
      expect(await db.settings.where("user_id").equals(userId).count()).toBe(1);
    });
    expect((await db.entries.get("e-file"))?.user_id).toBe(userId);
  });
});
