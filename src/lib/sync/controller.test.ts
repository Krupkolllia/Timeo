import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/db";
import { getCloudUserId } from "@/db/localUser";
import {
  completeFirstSignIn,
  confirmDifferentUser,
  handleAccountChange,
  runSync,
} from "@/lib/sync/controller";
import { useSyncStore } from "@/store/syncStore";
import { useUserStore } from "@/store/userStore";
import { FakeCloud } from "@/test/fakeCloud";
import { makeDayType, makeEntry, makePeriod, makeSettings, resetDb } from "@/test/factories";

const LOCAL_ID = "local-anon-uuid";
const ACCOUNT = { userId: "11111111-2222-3333-4444-555555555555", email: "test@example.com" };
const OTHER = { userId: "99999999-8888-7777-6666-555555555555", email: "other@example.com" };

function resetStores() {
  useSyncStore.setState({
    phase: "disabled",
    account: null,
    lastSyncAt: null,
    lastError: null,
    choice: null,
    differentUser: null,
    busy: false,
  });
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
  resetStores();
});

describe("вход, когда в облаке уже есть данные", () => {
  it("преамбула раздела 5: спрашивает, что оставить, и до ответа не трогает базу", async () => {
    await seedLocalWork(LOCAL_ID);
    const cloud = new FakeCloud();
    cloud.seed("day_types", [makeDayType({ id: "dt-cloud", user_id: ACCOUNT.userId })]);
    cloud.seed("periods", [makePeriod({ id: "p-cloud", user_id: ACCOUNT.userId, base_rate: 44.9 })]);
    cloud.seed("entries", [
      makeEntry({
        id: "e-cloud",
        user_id: ACCOUNT.userId,
        day_type_id: "dt-cloud",
        date: "2026-08-19",
        amount: 517.42,
      }),
    ]);

    await handleAccountChange(db, cloud, ACCOUNT, "test");

    expect(useSyncStore.getState().phase).toBe("choice_required");
    // Ни одна строка не переехала и ни одна облачная не легла: выбор не сделан.
    expect((await db.entries.get("e-open"))?.user_id).toBe(LOCAL_ID);
    expect(await db.entries.get("e-cloud")).toBeUndefined();
    expect(getCloudUserId()).toBeNull();
    // Закрыли приложение посреди выбора — активным остаётся анонимный
    // идентификатор, и на экранах те же данные, что и до входа.
    expect(useUserStore.getState().userId).toBe(LOCAL_ID);
  });

  it("ответ «добавить недостающее» переселяет данные и оставляет обе стороны", async () => {
    await seedLocalWork(LOCAL_ID);
    const cloud = new FakeCloud();
    cloud.seed("day_types", [makeDayType({ id: "dt-cloud", user_id: ACCOUNT.userId })]);
    cloud.seed("periods", [makePeriod({ id: "p-cloud", user_id: ACCOUNT.userId, base_rate: 44.9 })]);
    cloud.seed("entries", [
      makeEntry({
        id: "e-cloud",
        user_id: ACCOUNT.userId,
        day_type_id: "dt-cloud",
        date: "2026-08-19",
        amount: 517.42,
      }),
    ]);
    await handleAccountChange(db, cloud, ACCOUNT, "test");

    await completeFirstSignIn(db, cloud, "merge");

    expect(useSyncStore.getState().phase).toBe("idle");
    expect(getCloudUserId()).toBe(ACCOUNT.userId);
    expect(useUserStore.getState().userId).toBe(ACCOUNT.userId);
    expect((await db.entries.get("e-open"))?.amount).toBe(318.47);
    expect((await db.entries.get("e-cloud"))?.amount).toBe(517.42);
    // И локальная запись уехала наверх этим же проходом.
    expect(cloud.row("entries", "e-open")).toBeDefined();
  });

  it("на чистой установке вопроса нет: терять нечего, облачная копия становится этим устройством", async () => {
    const cloud = new FakeCloud();
    cloud.seed("day_types", [makeDayType({ id: "dt-cloud", user_id: ACCOUNT.userId })]);
    cloud.seed("entries", [
      makeEntry({ id: "e-cloud", user_id: ACCOUNT.userId, day_type_id: "dt-cloud", amount: 517.42 }),
    ]);

    await handleAccountChange(db, cloud, ACCOUNT, "test");

    expect(useSyncStore.getState().phase).toBe("idle");
    expect((await db.entries.get("e-cloud"))?.amount).toBe(517.42);
  });
});

describe("выход из аккаунта", () => {
  it("инвариант 44: не стирает локальную базу и не меняет активный user_id", async () => {
    await seedLocalWork(LOCAL_ID);
    const cloud = new FakeCloud();
    await handleAccountChange(db, cloud, ACCOUNT, "test");
    const afterSignIn = useUserStore.getState().userId;
    expect(afterSignIn).toBe(ACCOUNT.userId);

    await handleAccountChange(db, cloud, null, "test");

    expect(useSyncStore.getState().phase).toBe("signed_out");
    expect(await db.entries.count()).toBe(1);
    expect((await db.entries.get("e-open"))?.amount).toBe(318.47);
    expect((await db.periods.get("p-open"))?.base_rate).toBe(31.6);
    // Данные остаются под облачным идентификатором — иначе после выхода
    // появилась бы вторая копия тех же месяцев.
    expect(useUserStore.getState().userId).toBe(ACCOUNT.userId);
    expect(getCloudUserId()).toBe(ACCOUNT.userId);
  });
});

describe("вход другим пользователем", () => {
  it("инвариант 44: сначала предупреждение с числами, база цела", async () => {
    await seedLocalWork(LOCAL_ID);
    const cloud = new FakeCloud();
    await handleAccountChange(db, cloud, ACCOUNT, "test");

    await handleAccountChange(db, cloud, OTHER, "test");

    const state = useSyncStore.getState();
    expect(state.phase).toBe("different_user");
    expect(state.differentUser?.local.entries).toBe(1);
    expect(state.differentUser?.local.months_with_money).toBe(1);
    expect(await db.entries.count()).toBe(1);
    expect(getCloudUserId()).toBe(ACCOUNT.userId);
  });

  it("инвариант 44: стирает только после подтверждения", async () => {
    await seedLocalWork(LOCAL_ID);
    const cloud = new FakeCloud();
    await handleAccountChange(db, cloud, ACCOUNT, "test");
    await handleAccountChange(db, cloud, OTHER, "test");

    await confirmDifferentUser(db, cloud, "test");

    expect(await db.entries.count()).toBe(0);
    expect(await db.periods.count()).toBe(0);
    expect(getCloudUserId()).toBe(OTHER.userId);
    expect(useUserStore.getState().userId).toBe(OTHER.userId);
    // Приложение осталось рабочим: посев вернул настройки и типы дня.
    expect(await db.settings.where("user_id").equals(OTHER.userId).count()).toBe(1);
    expect(await db.day_types.where("user_id").equals(OTHER.userId).count()).toBeGreaterThan(0);
  });

  it("инвариант 44: предупреждение считает и то, что осталось под анонимным идентификатором", async () => {
    await seedLocalWork(LOCAL_ID);
    const cloud = new FakeCloud();
    // Вошли, поработали ещё, и часть строк осталась под старым анонимным id —
    // так выглядит база, где localStorage чистился отдельно от IndexedDB.
    localStorage.setItem("timeo:cloud-user-id", ACCOUNT.userId);
    await db.entries.put(makeEntry({ id: "e-cloud-user", user_id: ACCOUNT.userId, date: "2026-09-02", amount: 271.53 }));

    await handleAccountChange(db, cloud, OTHER, "test");

    const warning = useSyncStore.getState().differentUser;
    expect(warning?.local.entries).toBe(2);
    expect(warning?.local.months_with_money).toBe(2);
  });

  it("пустую базу вход другим аккаунтом не заставляет подтверждать стирание", async () => {
    const cloud = new FakeCloud();
    localStorage.setItem("timeo:cloud-user-id", ACCOUNT.userId);

    await handleAccountChange(db, cloud, OTHER, "test");

    expect(useSyncStore.getState().phase).toBe("idle");
    expect(localStorage.getItem("timeo:cloud-user-id")).toBe(OTHER.userId);
  });

  it("синхронизация не идёт, пока висит вопрос или предупреждение", async () => {
    await seedLocalWork(LOCAL_ID);
    const cloud = new FakeCloud();
    await handleAccountChange(db, cloud, ACCOUNT, "test");
    await handleAccountChange(db, cloud, OTHER, "test");
    const pushesBefore = cloud.pushedChunks.length;

    await runSync(db, cloud);

    expect(cloud.pushedChunks.length).toBe(pushesBefore);
  });
});

describe("облако не настроено", () => {
  it("инвариант 39: без шлюза приложение просто ничего не синхронизирует", async () => {
    await seedLocalWork(LOCAL_ID);

    await handleAccountChange(db, null, ACCOUNT, "test");

    expect(useSyncStore.getState().phase).toBe("disabled");
    expect(await db.entries.count()).toBe(1);
  });
});
