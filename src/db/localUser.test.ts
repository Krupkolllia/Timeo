import { beforeEach, describe, expect, it } from "vitest";
import { getLocalUserId } from "@/db/localUser";

describe("getLocalUserId", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("generates an id on first launch and stores it", () => {
    const id = getLocalUserId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem("timeo:local-user-id")).toBe(id);
  });

  it("returns the same id on every later call", () => {
    // Раздел 5: до входа в аккаунт весь user_id держится на этой строке.
    // Новый id при каждом запуске означал бы, что данные прошлого запуска
    // просто перестают находиться.
    const first = getLocalUserId();
    expect(getLocalUserId()).toBe(first);
  });
});
