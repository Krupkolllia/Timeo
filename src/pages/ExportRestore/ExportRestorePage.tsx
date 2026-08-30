import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useBackTo } from "@/app/useBackTo";
import { db } from "@/db/db";
import { useActiveUserId } from "@/store/userStore";
import { importBackup, readBackup } from "@/db/backup";
import { backupFileName, serializeBackup, type BackupFile } from "@/lib/export/backup";
import { deliverBackupFile, readTextFile, type DeliveryOutcome } from "@/lib/export/deliver";
import { parseBackup, type BackupParseError } from "@/lib/export/parse";
import type { ImportCounts, ImportMode } from "@/lib/export/importPlan";
import { ru } from "@/i18n/ru";

interface ChosenFile {
  name: string;
  file: BackupFile;
}

function errorText(error: BackupParseError): string {
  switch (error.kind) {
    case "invalid_json":
      return ru.backup.errorInvalidJson;
    case "not_a_backup":
      return ru.backup.errorNotBackup;
    case "unsupported_version":
      return ru.backup.errorUnsupportedVersion;
    case "invalid_table":
      return `${ru.backup.errorInvalidTable} ${error.table}${error.index >= 0 ? ` #${error.index + 1}` : ""}`;
  }
}

function outcomeText(outcome: DeliveryOutcome): string {
  switch (outcome.kind) {
    case "shared":
      return ru.backup.statusShared;
    case "downloaded":
      return ru.backup.statusDownloaded;
    case "cancelled":
      return ru.backup.statusCancelled;
    case "failed":
      return `${ru.backup.statusFailed} ${outcome.message}`;
  }
}

export function ExportRestorePage() {
  const userId = useActiveUserId();
  const [searchParams] = useSearchParams();
  // return= — запасной адрес для холодного входа; при живой истории «назад»
  // идёт по ней, иначе экран периода и этот экран зацикливались друг на друге.
  const goBack = useBackTo(searchParams.get("return") ?? "/");

  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ChosenFile | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importCounts, setImportCounts] = useState<ImportCounts | null>(null);
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Замок на время работы: экспорт и импорт — не мгновенные операции, а
  // повторный тап по кнопке во время импорта запустил бы второй проход по тем
  // же данным.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  async function handleExport() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setExportStatus(null);
    try {
      const file = await readBackup(db, userId, __APP_VERSION__);
      const outcome = await deliverBackupFile(serializeBackup(file), backupFileName(new Date()));
      setExportStatus(outcomeText(outcome));
    } catch (error) {
      // Молча не заканчиваем никогда: на скриншоте с телефона «ничего не
      // произошло» неотличимо от сломанной сборки (раздел 12).
      setExportStatus(`${ru.backup.statusFailed} ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function handleFileChosen(file: File | undefined) {
    setChosen(null);
    setImportCounts(null);
    setImportError(null);
    // Сбрасываем значение поля сразу: браузер не шлёт change, если выбран тот
    // же самый файл, что и в прошлый раз, и повторный выбор после ошибки не
    // делал бы ничего — а «ничего не произошло» неотличимо от сломанной сборки.
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;

    let text: string;
    try {
      text = await readTextFile(file);
    } catch (error) {
      setImportError(`${ru.backup.errorRead} ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // Разбор и проверка целиком до первой записи в базу (инвариант 49): здесь
    // ничего ещё не пишется, экран лишь показывает, что в файле.
    const parsed = parseBackup(text, new Date().toISOString());
    if (!parsed.ok) {
      setImportError(errorText(parsed.error));
      return;
    }
    setChosen({ name: file.name, file: parsed.file });
  }

  async function runImport(mode: ImportMode) {
    if (!chosen || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setImportError(null);
    try {
      const counts = await importBackup(db, userId, chosen.file, mode);
      setImportCounts(counts);
      // Файл применён — второй раз тот же самый применять незачем, а кнопки,
      // оставшиеся на экране, читались бы как «ещё не сделано».
      setChosen(null);
    } catch (error) {
      setImportError(`${ru.backup.errorImport} ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-app-bg text-app-fg">
      <header className="flex shrink-0 items-center gap-1 px-2 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-2">
        <button
          className="rounded-full p-3 text-xl text-app-fg/70 active:bg-app-fg/10"
          onClick={goBack}
          aria-label={ru.backup.back}
        >
          ‹
        </button>
        <span className="min-w-0 truncate text-lg font-semibold tracking-tight">{ru.backup.title}</span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
        <section>
          <h2 className="text-xs text-app-fg/40">{ru.backup.exportTitle}</h2>
          <p className="mt-1 text-xs text-app-fg/40">{ru.backup.exportNote}</p>
          <button
            className="mt-3 min-h-11 w-full rounded-lg bg-app-accent py-3 text-sm font-semibold text-app-accent-fg active:opacity-80 disabled:opacity-50"
            disabled={busy}
            onClick={() => void handleExport()}
          >
            {ru.backup.exportAction}
          </button>
          {/* Высота строки исхода зарезервирована: появляясь после нажатия, она
              иначе сдвигала бы вниз весь раздел импорта. */}
          <p className={`mt-2 min-h-8 text-xs ${exportStatus ? "text-app-fg/60" : "text-transparent"}`}>
            {exportStatus ?? "—"}
          </p>
        </section>

        <section>
          <h2 className="text-xs text-app-fg/40">{ru.backup.importTitle}</h2>
          <p className="mt-1 text-xs text-app-fg/40">{ru.backup.importNote}</p>

          {/* Обёртка label вокруг input: системная кнопка выбора файла не
              поддаётся оформлению, а цель нажатия должна быть 44px. */}
          <label className="mt-3 flex min-h-11 w-full items-center justify-center rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20">
            {ru.backup.chooseFile}
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              aria-label={ru.backup.chooseFile}
              onChange={(event) => void handleFileChosen(event.target.files?.[0])}
            />
          </label>

          {/* Ошибка разбора: данные не изменились, и текст говорит именно это. */}
          <p className={`mt-2 min-h-8 text-xs ${importError ? "text-app-fg/60" : "text-transparent"}`}>
            {importError ?? "—"}
          </p>

          {chosen && (
            <div className="mt-1 flex flex-col gap-3 rounded-xl bg-app-fg/5 px-3 py-3">
              <p className="truncate text-xs text-app-fg/50">
                {ru.backup.fileChosen} {chosen.name}
              </p>
              <p className="text-xs text-app-fg/40">
                {chosen.file.periods.length} {ru.backup.contentsPeriods} · {chosen.file.day_types.length}{" "}
                {ru.backup.contentsDayTypes} · {chosen.file.entries.length} {ru.backup.contentsEntries} ·{" "}
                {chosen.file.holidays.length} {ru.backup.contentsHolidays}
              </p>
              {/* Инвариант 47: два режима, и ни один не выбран заранее —
                  молчаливое слияние не бывает по умолчанию. */}
              <button
                className="min-h-11 w-full rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20 disabled:opacity-50"
                disabled={busy}
                onClick={() => void runImport("merge")}
              >
                {ru.backup.modeMerge}
              </button>
              <p className="-mt-2 text-xs text-app-fg/30">{ru.backup.modeMergeHint}</p>
              <button
                className="min-h-11 w-full rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20 disabled:opacity-50"
                disabled={busy}
                onClick={() => setReplaceConfirmOpen(true)}
              >
                {ru.backup.modeReplace}
              </button>
              <p className="-mt-2 text-xs text-app-fg/30">{ru.backup.modeReplaceHint}</p>
            </div>
          )}

          {importCounts && (
            <div className="mt-3 rounded-xl bg-app-fg/5 px-3 py-3 text-xs text-app-fg/60">
              <p className="font-semibold text-app-fg/80">{ru.backup.importedTitle}</p>
              <p className="mt-1">
                {importCounts.periods} {ru.backup.contentsPeriods} · {importCounts.day_types}{" "}
                {ru.backup.contentsDayTypes} · {importCounts.entries} {ru.backup.contentsEntries} ·{" "}
                {importCounts.holidays} {ru.backup.contentsHolidays}
              </p>
              {importCounts.skipped > 0 && (
                <p className="mt-1 text-app-fg/40">
                  {importCounts.skipped} {ru.backup.importedSkipped}
                </p>
              )}
              {importCounts.repointed_entries > 0 && (
                <p className="mt-1 text-app-fg/40">
                  {importCounts.repointed_entries} {ru.backup.importedRepointed}
                </p>
              )}
              {importCounts.recovered_entries > 0 && (
                <p className="mt-1 text-app-fg/40">
                  {importCounts.recovered_entries} {ru.backup.importedRecovered}
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Раздел 7.10: подтверждений во всём приложении ровно два — переоткрытие
          закрытого периода и замена данных при импорте (инвариант 56). Это
          второй. */}
      {replaceConfirmOpen && (
        <div
          className="day-sheet-overlay fixed inset-0 z-40 flex items-center justify-center bg-app-scrim/60 p-6"
          onClick={() => setReplaceConfirmOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-app-surface p-4 text-app-fg"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="text-base font-semibold">{ru.backup.replaceConfirmTitle}</p>
            <p className="mt-2 text-sm text-app-fg/50">{ru.backup.replaceConfirmBody}</p>
            <div className="mt-4 flex gap-3">
              <button
                className="min-h-11 flex-1 rounded-lg bg-app-fg/10 py-3 text-sm font-medium active:bg-app-fg/20"
                onClick={() => setReplaceConfirmOpen(false)}
              >
                {ru.backup.cancel}
              </button>
              <button
                className="min-h-11 flex-1 rounded-lg bg-app-accent py-3 text-sm font-semibold text-app-accent-fg active:opacity-80"
                onClick={() => {
                  setReplaceConfirmOpen(false);
                  void runImport("replace");
                }}
              >
                {ru.backup.replaceConfirmAction}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
