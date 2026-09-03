import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { SplashSkull } from '../components/SplashSkull';
import { RedConfigs } from './RedConfigs';
import { RedServers } from './RedServers';
import { RedSpeedtest } from './RedSpeedtest';

// Инфраструктура: скрытый раздел управления своими узлами (NODE_PANEL в .env).
// Оболочка со своей заставкой и вложенными разделами: «Серверы» и «Конфигурации».

// Арт заставки: владелец кладёт свою картинку в web/src/assets/splash-skull.(png|jpg|jpeg|webp) —
// glob подхватит её при сборке; пока файла нет, показывается запасной векторный череп
const skullArt = import.meta.glob('../assets/splash-skull.{png,jpg,jpeg,webp}', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>;
const skullArtUrl = Object.values(skullArt)[0];

// вход-анимация: розжиг с помехами, глитчи арта, живые глаза (~3.2 с), потом створки шлюза
function EntryGate({ onDone }: { onDone: () => void }) {
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    const openT = setTimeout(() => setOpening(true), 3200);
    const doneT = setTimeout(onDone, 4000);
    return () => {
      clearTimeout(openT);
      clearTimeout(doneT);
    };
  }, [onDone]);

  const art = { backgroundImage: `url(${skullArtUrl})` };

  return (
    // клик — пропустить заставку и сразу открыть створки
    <div className={`rr-overlay${opening ? ' rr-opening' : ''}`} onClick={() => setOpening(true)}>
      <div className="rr-flash" />
      <div className="rr-door rr-door-top" />
      <div className="rr-door rr-door-bottom" />
      <div className="rr-grain" />
      <div className="rr-splash">
        {skullArtUrl ? (
          <div className="rrp-wrap">
            <div className="rrp-glow" />
            <img alt="" className="rrp-img" src={skullArtUrl} />
            {/* RGB-расслоение: красная и голубая копии вспыхивают сдвинутыми полосами */}
            <div className="rrp-ghost rrp-ghost-r" style={art} />
            <div className="rrp-ghost rrp-ghost-c" style={art} />
            {/* рваные слайсы-помехи */}
            <div className="rrp-slice rrp-slice-a" style={art} />
            <div className="rrp-slice rrp-slice-b" style={art} />
            {/* живые глаза: свечение точно по глазницам арта */}
            <div className="rrp-eye rrp-eye-l" />
            <div className="rrp-eye rrp-eye-r" />
            {/* бегущий скан-луч */}
            <div className="rrp-scanline" />
          </div>
        ) : (
          <SplashSkull />
        )}
        <div className="rr-glitch" data-text="ИНФРАСТРУКТУРА">
          ИНФРАСТРУКТУРА
        </div>
        <div className="rr-splash-sub">СИСТЕМА ГОТОВА</div>
      </div>
    </div>
  );
}

export function NodePanel() {
  const [entered, setEntered] = useState(false);

  return (
    <>
      {!entered && <EntryGate onDone={() => setEntered(true)} />}

      <div className="node-panel">
        <Routes>
          <Route element={<RedServers />} path="servers" />
          <Route element={<RedConfigs />} path="configs" />
          <Route element={<RedSpeedtest />} path="speedtest" />
          <Route element={<Navigate replace to="/nodes/servers" />} path="*" />
        </Routes>
      </div>
    </>
  );
}
