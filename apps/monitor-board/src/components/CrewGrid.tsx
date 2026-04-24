import React from 'react';

const pixelMons = ['pikachu', 'charizard', 'gengar'] as const;
type PixelMon = (typeof pixelMons)[number];

const pixelMonLabels: Record<PixelMon, string> = {
  pikachu: 'Pikachu',
  charizard: 'Charizard',
  gengar: 'Gengar',
};

const pixelMonPalettes = {
  pikachu: {
    y: '#ffd84e',
    k: '#0b1020',
    r: '#ff5c7a',
  },
  charizard: {
    o: '#ff9a3c',
    d: '#db6a1c',
    w: '#fff2cf',
    k: '#0b1020',
    b: '#54c7ff',
    r: '#ff5c7a',
    y: '#ffd84e',
  },
  gengar: {
    p: '#8f5bff',
    r: '#ff5c7a',
    w: '#e8dcff',
  },
} as const;

const pixelMonSprites: Record<PixelMon, string[]> = {
  pikachu: [
    'k......k..',
    'ykyyyyky..',
    'yyyyyyyy..',
    'yyyyyyyy..',
    'yykyyyky..',
    'yyyyyyyy..',
    'yryykkyry.',
    '.yyyyyyy..',
    '..yyyyy...',
    '...y.y....',
  ],
  charizard: [
    '.b....b...',
    'boooooob..',
    'oooooooo..',
    'ookooooko.',
    'ooowwwoo..',
    'oowwwwwo..',
    '.ooowwoor.',
    '..oooooy..',
    '...oooo...',
    '....oo....',
  ],
  gengar: [
    '.p.p..p.p.',
    'pppppppppp',
    'pppr..rppp',
    'pppppppppp',
    'pppwwwpppp',
    '.ppwwwwpp.',
    '..pppppp..',
    '...pppp...',
    '...p..p...',
    '..........',
  ],
};

const PixelPetSprite = ({ pixelMon }: { pixelMon: PixelMon }) => {
  const sprite = pixelMonSprites[pixelMon];
  const palette = pixelMonPalettes[pixelMon];
  const pixelSize = 6;

  return (
    <svg className="crew-card-sprite-svg" viewBox="0 0 60 60" aria-hidden="true" focusable="false">
      {sprite.flatMap((row, y) =>
        Array.from(row).flatMap((token, x) => {
          if (token === '.') {
            return [];
          }

          const fill = palette[token as keyof typeof palette];

          if (!fill) {
            return [];
          }

          return (
            <rect
              key={`${pixelMon}-${x}-${y}`}
              x={x * pixelSize}
              y={y * pixelSize}
              width={pixelSize}
              height={pixelSize}
              fill={fill}
            />
          );
        }),
      )}
    </svg>
  );
};

export interface CrewCard {
  id: string;
  name: string;
  role: string;
  status: string;
  actorType: string;
  primaryDetail: string;
  secondaryDetail: string;
  progressPercent: number;
  progressStage: string;
  progressLabel: string;
  metricLabel: string;
}

interface CrewGridProps {
  actors: CrewCard[];
  selectedActorId: string | null;
  onFocus: (actorId: string) => void;
}

export const CrewGrid = ({ actors, selectedActorId, onFocus }: CrewGridProps) => {
  const toPixelMon = (actor: CrewCard, index: number): PixelMon => {
    const seed = `${actor.id}:${actor.actorType}:${actor.role}`;
    const hash = Array.from(seed).reduce((total, char, charIndex) => {
      return total + char.charCodeAt(0) * (charIndex + 1);
    }, 0);

    return pixelMons[(hash + index) % pixelMons.length];
  };

  return (
    <section className="pixel-panel board-panel">
      <div className="panel-section">
        <h2 className="panel-title">PIXEL CREW</h2>
        <div className="crew-grid">
          {actors.map((actor, index) => {
            const isSelected = actor.id === selectedActorId;
            const pixelMon = toPixelMon(actor, index);

            return (
              <button
                key={actor.id}
                type="button"
                aria-label={actor.name}
                aria-pressed={isSelected}
                className={`crew-card${isSelected ? ' is-selected' : ''}`}
                data-role={actor.role}
                data-status={actor.status}
                data-actor-type={actor.actorType}
                data-pixel-mon={pixelMon}
                onClick={() => onFocus(actor.id)}
              >
                <div className="crew-card-chrome">
                  <div className="crew-card-sprite" aria-hidden="true">
                    <PixelPetSprite pixelMon={pixelMon} />
                  </div>
                  <div className="crew-card-badges">
                    <span className="crew-card-role">{actor.role}</span>
                    <span className="crew-card-status">{actor.status}</span>
                    <span className="crew-card-stage">{actor.progressStage}</span>
                    <span className="crew-card-pet">{pixelMonLabels[pixelMon]}</span>
                  </div>
                </div>

                <div className="crew-card-copy">
                  <strong className="crew-card-name">{actor.name}</strong>
                  <span className="crew-card-summary">{actor.primaryDetail}</span>
                  <span className="crew-card-summary">{actor.secondaryDetail}</span>
                </div>

                <div className="crew-card-footer">
                  <div className="crew-card-progress" aria-label={`${actor.name} progress ${actor.progressPercent}%`}>
                    <span className="crew-card-progress-label">{actor.progressLabel}</span>
                    <span className="crew-card-progress-track" aria-hidden="true">
                      <span className="crew-card-progress-fill" style={{ width: `${actor.progressPercent}%` }} />
                    </span>
                  </div>
                  <span className="crew-card-metric">{actor.metricLabel}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
};
