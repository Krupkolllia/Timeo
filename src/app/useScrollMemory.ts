import { useEffect, useLayoutEffect } from "react";

const positions = new Map<string, number>();

/**
 * Запоминает прокрутку экрана между заходами в рамках сессии. Переходы вроде
 * «Настройки → Прошлые периоды → назад» — это push-навигация, а не popstate
 * (кнопка «назад» на внутреннем экране сама зовёт navigate(-1) или
 * navigate(returnTo)), и нативное восстановление прокрутки браузера тут не
 * срабатывает — react-router-dom's `ScrollRestoration` тоже не подходит: ей
 * нужен дата-роутер (createBrowserRouter/RouterProvider), а тесты рендерят
 * экраны в обычном MemoryRouter (та же причина, по которой TabBar не живёт в
 * общем layout-маршруте, см. компонент TabBar).
 *
 * Прокручивается здесь именно `document.body`, а не `window`: html и body у
 * этого приложения зафиксированы в 100% высоты (src/styles/index.css), из-за
 * чего собственный скроллбар документа не растёт — оверфлоу контента gets
 * contained внутри body как отдельный скролл-контейнер, а window.scrollY
 * остаётся нулём (проверено в браузере — на экране настроек 390×844 реальная
 * прокрутка двигает body.scrollTop, а не window.scrollY).
 *
 * ready — контент экрана уже готов (данные из Dexie приехали) и имеет
 * итоговую высоту; без этого восстановление целится в документ высотой в
 * один спиннер.
 */
export function useScrollMemory(key: string, ready: boolean) {
  useLayoutEffect(() => {
    if (!ready) return;
    const saved = positions.get(key);
    if (saved) document.body.scrollTop = saved;
  }, [key, ready]);

  useEffect(() => {
    if (!ready) return;
    const onScroll = () => positions.set(key, document.body.scrollTop);
    document.body.addEventListener("scroll", onScroll, { passive: true });
    // Не сохраняем ещё раз при размонтировании: та же самая body уже
    // делит DOM со следующим экраном, и его контент (часто короче,
    // особенно пока свои данные из Dexie ещё не приехали) успевает обрезать
    // body.scrollTop ДО того, как отработает cleanup — cleanup прочитал бы
    // уже урезанное значение и затёр бы верную позицию, которую onScroll
    // сохранил заранее.
    return () => document.body.removeEventListener("scroll", onScroll);
  }, [key, ready]);
}
