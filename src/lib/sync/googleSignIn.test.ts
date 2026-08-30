import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/db";
import { getCloudUserId } from "@/db/localUser";
import { completeOAuthReturn } from "@/lib/sync/auth";
import { completeFirstSignIn, confirmDifferentUser, handleAccountChange } from "@/lib/sync/controller";
import { useSyncStore } from "@/store/syncStore";
import { useUserStore } from "@/store/userStore";
import { FakeCloud } from "@/test/fakeCloud";
import { makeDayType, makeEntry, makePeriod, makeSettings, resetDb } from "@/test/factories";

/**
 * Google — это ещё один способ получить AuthAccount, и ничего больше. Здесь
 * проверяется именно это: возврат от провайдера уходит в тот же
 * handleAccountChange, что и вход паролем, и первый вход, предупреждение о
 * другом пользователе и вопрос «что оставить» остаются одним и тем же кодом.
 * Сеть — только мок: ни настоящего Supabase, ни настоящего Google.
 */
// vi.hoisted: syncStore спрашивает isCloudConfigured уже на импорте, то есть
// раньше, чем выполнится тело файла.
const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  signInWithOAuth: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
}));

vi.mock("@/lib/sync/supabaseClient", () => ({
  get supabase() {
    return { auth };
  },
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "anon",
}));

const LOCAL_ID = "local-anon-uuid";
const GOOGLE = { userId: "11111111-2222-3333-4444-555555555555", email: "father@example.com" };
const OTHER = { userId: "99999999-8888-7777-6666-555555555555", email: "other@example.com" };

/** Человек вернулся от провайдера: адрес с кодом, обмен отдаёт эту сессию. */
async function returnFromGoogle(account: { userId: string; email: string }) {
  window.history.replaceState({ idx: 0 }, "", "/more/account?code=code-8100&state=state-8100");
  auth.exchangeCodeForSession.mockResolvedValue({
    data: { session: { user: { id: account.userId, email: account.email } } },
    error: null,
  });
  const returned = await completeOAuthReturn();
  if (returned.kind !== "signed_in") throw new Error(`возврат не дал сессии: ${returned.kind}`);
  return returned.account;
}

async function seedLocalWork(userId: string) {
  await db.settings.put(makeSettings({ id: "s-1", user_id: userId }));
  await db.day_types.put(makeDayType({ user_id: userId }));
  await db.periods.put(makePeriod({ id: "p-open", user_id: userId, base_rate: 31.6 }));
  await db.entries.put(makeEntry({ id: "e-open", user_id: userId, date: "2026-08-11", amount: 318.47 }));
}

beforeEach(async () => {
  await resetDb();
  localStorage.clear();
  localStorage.setItem("timeo:local-user-id", LOCAL_ID);
  useUserStore.setState({ userId: LOCAL_ID });
  useSyncStore.setState({
    phase: "signed_out",
    account: null,
    lastSyncAt: null,
    lastError: null,
    choice: null,
    differentUser: null,
    signInError: null,
    busy: false,
  });
  vi.clearAllMocks();
});

describe("первый вход через Google", () => {
  it("инвариант 47: при данных с обеих сторон задаётся тот же вопрос с двумя режимами", async () => {
    await seedLocalWork(LOCAL_ID);
    const cloud = new FakeCloud();
    cloud.seed("day_types", [makeDayType({ id: "dt-cloud", user_id: GOOGLE.userId })]);
    cloud.seed("periods", [makePeriod({ id: "p-cloud", user_id: GOOGLE.userId, base_rate: 44.9 })]);
    cloud.seed("entries", [
      makeEntry({ id: "e-cloud", user_id: GOOGLE.userId, day_type_id: "dt-cloud", date: "2026-08-19", amount: 517.42 }),
    ]);

    const account = await returnFromGoogle(GOOGLE);
    await handleAccountChange(db, cloud, account, "test");

    const state = useSyncStore.getState();
    expect(state.phase).toBe("choice_required");
    expect(state.choice?.local.entries).toBe(1);
    expect(state.choice?.cloud.entries).toBe(1);
    // До ответа не тронуто ничего, ровно как при входе паролем.
    expect((await db.entries.get("e-open"))?.user_id).toBe(LOCAL_ID);
    expect(await db.entries.get("e-cloud")).toBeUndefined();
    expect(getCloudUserId()).toBeNull();

    await completeFirstSignIn(db, cloud, "merge");

    expect(useSyncStore.getState().phase).toBe("idle");
    expect((await db.entries.get("e-open"))?.user_id).toBe(GOOGLE.userId);
    expect((await db.entries.get("e-cloud"))?.amount).toBe(517.42);
  });

  it("на чистой установке переезжает молча и без вопроса", async () => {
    await db.settings.put(makeSettings({ id: "s-1", user_id: LOCAL_ID }));
    await db.day_types.put(makeDayType({ user_id: LOCAL_ID }));
    const cloud = new FakeCloud();

    const account = await returnFromGoogle(GOOGLE);
    await handleAccountChange(db, cloud, account, "test");

    expect(useSyncStore.getState().phase).toBe("idle");
    expect(getCloudUserId()).toBe(GOOGLE.userId);
    expect(useSyncStore.getState().differentUser).toBeNull();
  });
});

describe("повторный возврат от Google", () => {
  it("тот же auth.uid не поднимает предупреждения о стирании", async () => {
    localStorage.setItem("timeo:cloud-user-id", GOOGLE.userId);
    useUserStore.setState({ userId: GOOGLE.userId });
    await seedLocalWork(GOOGLE.userId);
    const cloud = new FakeCloud();

    const account = await returnFromGoogle(GOOGLE);
    await handleAccountChange(db, cloud, account, "test");

    const state = useSyncStore.getState();
    expect(state.differentUser).toBeNull();
    expect(state.phase).not.toBe("different_user");
    expect((await db.entries.get("e-open"))?.amount).toBe(318.47);
  });

  it("возврат дважды подряд не переселяет данные во второй раз", async () => {
    await seedLocalWork(LOCAL_ID);
    const cloud = new FakeCloud();

    const first = await returnFromGoogle(GOOGLE);
    const second = await returnFromGoogle(GOOGLE);
    await Promise.all([
      handleAccountChange(db, cloud, first, "test"),
      handleAccountChange(db, cloud, second, "test"),
    ]);

    expect(getCloudUserId()).toBe(GOOGLE.userId);
    expect(await db.entries.where("user_id").equals(GOOGLE.userId).count()).toBe(1);
    expect(await db.entries.where("user_id").equals(LOCAL_ID).count()).toBe(0);
  });
});

describe("вход через Google под другим аккаунтом", () => {
  it("инвариант 44: предупреждение с числами, и стирание только после подтверждения", async () => {
    localStorage.setItem("timeo:cloud-user-id", OTHER.userId);
    useUserStore.setState({ userId: OTHER.userId });
    await seedLocalWork(OTHER.userId);
    const cloud = new FakeCloud();

    const account = await returnFromGoogle(GOOGLE);
    await handleAccountChange(db, cloud, account, "test");

    const warning = useSyncStore.getState().differentUser;
    expect(useSyncStore.getState().phase).toBe("different_user");
    expect(warning?.local.entries).toBe(1);
    expect(warning?.local.periods).toBe(1);
    // Пока не подтвердили — не стёрто ничего.
    expect((await db.entries.get("e-open"))?.amount).toBe(318.47);
    expect(getCloudUserId()).toBe(OTHER.userId);

    await confirmDifferentUser(db, cloud, "test");

    expect(await db.entries.get("e-open")).toBeUndefined();
    expect(getCloudUserId()).toBe(GOOGLE.userId);
  });
});
