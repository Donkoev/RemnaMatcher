import { useEffect, useState } from 'react';
import { userModalController } from '../userModal';
import { UserReportModal } from './UserReportModal';

/**
 * Держит состояние открытого отчёта по юзеру отдельно от App:
 * открытие/закрытие модалки перерендеривает только этот компонент,
 * а не всю страницу с тяжёлой сеткой карточек.
 */
export function UserModalHost() {
  const [userId, setUserId] = useState<number | null>(null);

  useEffect(() => {
    userModalController.open = setUserId;
    return () => {
      userModalController.open = () => {};
    };
  }, []);

  return <UserReportModal onClose={() => setUserId(null)} userId={userId} />;
}
