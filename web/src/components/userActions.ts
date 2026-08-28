import { TbBan, TbCheck, TbDeviceMobileOff, TbHeart, TbPlugOff, TbRefreshAlert } from 'react-icons/tb';
import type { ActionName } from '../api';

export interface ActionDef {
  action: ActionName;
  color: string;
  confirm: string;
  Icon: React.ComponentType<{ size?: number }>;
  label: string;
}

export const USER_ACTIONS: ActionDef[] = [
  {
    action: 'revoke',
    color: 'orange',
    Icon: TbRefreshAlert,
    label: 'Revoke ключей',
    confirm: 'Перегенерировать ключи? Утёкший vless умрёт, легитимный юзер обновится по своей ссылке подписки.',
  },
  {
    action: 'disable',
    color: 'red',
    Icon: TbBan,
    label: 'Отключить',
    confirm: 'Полностью отключить юзера в панели?',
  },
  {
    action: 'enable',
    color: 'teal',
    Icon: TbCheck,
    label: 'Включить',
    confirm: 'Включить юзера обратно?',
  },
  {
    action: 'drop',
    color: 'blue',
    Icon: TbPlugOff,
    label: 'Сбросить соединения',
    confirm: 'Сбросить все активные соединения юзера на всех нодах?',
  },
  {
    action: 'hwid_ban',
    color: 'red',
    Icon: TbDeviceMobileOff,
    label: 'Забанить устройства',
    confirm:
      'Все HWID-устройства юзера уйдут в чёрный список, подписка отключится. Если любое из устройств всплывёт в другой подписке — та отключится автоматически.',
  },
  {
    action: 'whitelist',
    color: 'teal',
    Icon: TbHeart,
    label: 'В белый список',
    confirm: 'Добавить в белый список? Уведомления по этому юзеру прекратятся.',
  },
  {
    action: 'unwhitelist',
    color: 'gray',
    Icon: TbHeart,
    label: 'Из белого списка',
    confirm: 'Убрать юзера из белого списка? Уведомления по нему возобновятся.',
  },
];
