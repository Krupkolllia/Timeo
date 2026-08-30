import { Component, type ErrorInfo, type ReactNode } from "react";
import { useRouteError } from "react-router-dom";
import { ru } from "@/i18n/ru";

/**
 * Инвариант 58: приложение никогда не показывает пустой экран. Необработанная
 * ошибка рисует читаемую панель с текстом ошибки и кнопкой перезагрузки.
 *
 * Это не украшение, а единственный диагностический канал (раздел 12 ТЗ):
 * тестирование идёт удалённо, консоли и отладчика на телефоне нет, и всё, что
 * доходит до разработчика, — присланный скриншот. Поэтому здесь же стоят версия
 * и хеш сборки: без них «баг не исправлен» неотличимо от «на телефоне
 * закешировалась старая версия».
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  // react-router отдаёт свои ошибки маршрутизации объектом со status/statusText.
  if (error && typeof error === "object" && "status" in error) {
    const routeError = error as { status?: unknown; statusText?: unknown };
    return `${String(routeError.status ?? "")} ${String(routeError.statusText ?? "")}`.trim();
  }
  return String(error);
}

export function ErrorPanel({ error }: { error: unknown }) {
  return (
    <div className="flex min-h-dvh flex-col justify-center gap-4 bg-app-bg p-6 text-app-fg">
      <p className="text-lg font-semibold">{ru.error.title}</p>
      <p className="text-sm text-app-fg/50">{ru.error.body}</p>
      {/* Текст ошибки — то, что пользователь перешлёт скриншотом, поэтому он
          виден целиком и переносится, а не обрезается: break-words обязателен,
          иначе длинный стек одной строкой распирает экран по горизонтали
          (инвариант 26). */}
      <p className="max-h-48 overflow-y-auto break-words rounded-lg bg-app-fg/5 px-3 py-2 font-mono text-xs text-app-fg/70">
        {errorMessage(error)}
      </p>
      <p className="text-xs text-app-fg/30">
        v{__APP_VERSION__}
        {__BUILD_SHA__ && ` · ${__BUILD_SHA__}`}
      </p>
      {/* Кнопка внизу и на всю ширину — экран одноручный (инвариант 59). */}
      <button
        className="min-h-11 rounded-lg bg-app-accent py-3 text-sm font-semibold text-app-accent-fg active:opacity-80"
        onClick={() => window.location.reload()}
      >
        {ru.error.reload}
      </button>
    </div>
  );
}

/**
 * errorElement маршрута: ошибку отдаёт сам react-router. Тот же компонент
 * стоит на маршруте "*", где ошибки нет вовсе, — там показываем сам адрес,
 * иначе панель объясняла бы поломку словом "null".
 */
export function RouteErrorPanel() {
  const error = useRouteError();
  return <ErrorPanel error={error ?? `${ru.error.unknownAddress} ${window.location.pathname}`} />;
}

interface ErrorBoundaryState {
  error: unknown;
}

/**
 * Страховка на всё, что живёт вне маршрутов (UpdateBanner, сам RouterProvider).
 * Ошибки внутри экранов перехватывает errorElement маршрута и сюда не доходят.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Консоли на телефоне нет, но в браузере разработчика она есть — это
    // единственное место, где стек сохраняется целиком.
    console.error("Timeo: unhandled error", error, info.componentStack);
  }

  render() {
    if (this.state.error !== null) return <ErrorPanel error={this.state.error} />;
    return this.props.children;
  }
}
