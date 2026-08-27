import { createContext, useContext } from 'react';

/** Открытие всплывающего отчёта по юзеру поверх текущей страницы */
export const UserModalContext = createContext<{ openUser: (id: number) => void }>({
  openUser: () => {},
});

export function useUserModal() {
  return useContext(UserModalContext);
}

/**
 * Императивный контроллер: состояние открытой модалки живёт в отдельном
 * хост-компоненте, чтобы клик по юзеру не перерендеривал всё дерево страницы.
 */
export const userModalController: { open: (id: number) => void } = {
  open: () => {},
};
