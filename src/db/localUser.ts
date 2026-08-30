const STORAGE_KEY = "timeo:local-user-id";
const CLOUD_KEY = "timeo:cloud-user-id";

export function getLocalUserId(): string {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;

  const id = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}

/**
 * Идентификатор аккаунта, чьи строки лежат в этой локальной базе (блок 8).
 *
 * Записывается ТОЛЬКО после того, как первый вход доведён до конца: строки
 * пяти таблиц переписаны на настоящий user_id. Пока его нет, активным
 * идентификатором остаётся анонимный uuid, и на экранах видны те же данные,
 * что и до входа, — даже если сессия Supabase уже восстановлена.
 *
 * Он же отвечает на вопрос инварианта 44 «кто такой другой пользователь»:
 * другой — это вход под auth.uid, не равным этому значению, при непустой
 * базе. Вход под ним же — обычное продолжение работы.
 *
 * Выход из аккаунта значение НЕ стирает: по решению заказчика данные остаются
 * лежать под облачным user_id, иначе после выхода появилась бы вторая копия
 * тех же месяцев под анонимным идентификатором.
 */
export function getCloudUserId(): string | null {
  return localStorage.getItem(CLOUD_KEY);
}

export function setCloudUserId(userId: string): void {
  localStorage.setItem(CLOUD_KEY, userId);
}

export function clearCloudUserId(): void {
  localStorage.removeItem(CLOUD_KEY);
}

/**
 * Единственный ответ на вопрос «чьи строки показывать». Ровно один источник:
 * до первого доведённого до конца входа — анонимный uuid, после — облачный.
 */
export function getActiveUserId(): string {
  return getCloudUserId() ?? getLocalUserId();
}
