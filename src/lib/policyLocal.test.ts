import { describe, expect, it } from 'vitest';
import { evaluateAgainstPolicy, type PolicyInput } from './policyLocal';

function createInput(
  overrides: Partial<Omit<PolicyInput, 'signals'>> & {
    signals?: Partial<PolicyInput['signals']>;
  } = {},
): PolicyInput {
  const baseSentences = [
    'Pada hari Senin, 10 Oktober 2024, Pemerintah Kabupaten Bangkalan menggelar rapat koordinasi.',
    'Acara berlangsung di Aula Graha Bangkalan.',
    'Bupati Bangkalan Abdul Latif memimpin jalannya rapat.',
    'Sekretaris daerah serta para camat turut hadir pada kegiatan tersebut.',
    'Pertemuan dimulai pukul 09.00 WIB dengan agenda penajaman program.',
    'Para peserta mendiskusikan percepatan pelayanan publik terpadu.',
    'Rapat sekaligus mengevaluasi capaian kinerja triwulan ketiga.',
    'Setiap organisasi perangkat daerah memaparkan data realisasi.',
    'Bupati menekankan pentingnya kolaborasi lintas sektor.',
    'Ia juga meminta aparatur mengawal program prioritas.',
    'Keputusan rapat akan ditindaklanjuti dalam waktu satu minggu.',
    'Agenda ditutup dengan sesi tanya jawab bersama peserta.',
  ];

  const textValue = overrides.text ?? baseSentences.join(' ');

  const estimateSentenceCount = (value: string): number => {
    return value
      .split(/(?<=[.!?])\s+/u)
      .map((segment) => segment.trim())
      .filter(Boolean).length;
  };

  const baseSignals = {
    paragraphCount: 4,
    minSentencesPerParagraph: 3,
    imageCount: 2,
    allowedHostCount: 1,
    hostedImageCount: 1,
    sentenceCount:
      overrides.signals?.sentenceCount ??
      estimateSentenceCount(textValue),
    ...overrides.signals,
  };

  return {
    text: textValue,
    images:
      overrides.images ??
      [
        { src: 'https://i.ibb.co/sample-one.jpg', alt: '' },
        { src: 'https://i.ibb.co/sample-two.jpg', alt: '' },
      ],
    eventDate: overrides.eventDate ?? new Date('2024-10-10T00:00:00.000Z'),
    signals: baseSignals,
    nowJkt: overrides.nowJkt ?? new Date('2024-10-11T00:00:00.000Z'),
  };
}

describe('policyLocal', () => {
  it('passes image rule when foto diunggah via imgbb', () => {
    const result = evaluateAgainstPolicy(
      createInput({
        images: [
          { src: 'https://i.ibb.co/image-one.jpg', alt: '' },
          { src: 'https://bangkalankab.go.id/uploads/foto-2.jpg', alt: '' },
        ],
        signals: {
          imageCount: 2,
          allowedHostCount: 1,
        },
      }),
    );

    expect(result.violations).not.toContain('#I1 Foto Hosting');
    expect(result.details.externalImageHosts).toContain('i.ibb.co');
  });

  it('flags image rule when tidak ada hosting eksternal', () => {
    const result = evaluateAgainstPolicy(
      createInput({
        images: [
          {
            src: 'https://bangkalankab.go.id/uploads/foto-1.jpg',
            alt: '',
          },
          {
            src: 'https://bangkalankab.go.id/uploads/foto-2.jpg',
            alt: '',
          },
        ],
        signals: {
          allowedHostCount: 0,
          hostedImageCount: 0,
        },
      }),
    );

    expect(result.violations).toContain('#I1 Foto Hosting');
  });

  it('flags sentence count rule when below threshold', () => {
    const result = evaluateAgainstPolicy(
      createInput({
        text: 'Ini kalimat pertama. Ini kalimat kedua. Ini kalimat ketiga. Ini kalimat keempat. Ini kalimat kelima.',
      }),
    );

    expect(result.violations).toContain('#T3 Jumlah Kalimat');
    expect(result.details.sentenceCount).toBeLessThan(12);
  });

  it('flags missing core info when kapan, di mana, siapa tidak ditemukan', () => {
    const result = evaluateAgainstPolicy(
      createInput({
        text: 'Kegiatan sosialisasi program berlangsung lancar sepanjang sesi. Agenda berfokus pada penyampaian materi layanan publik. Tim internal memastikan seluruh rangkaian berjalan interaktif.',
      }),
    );

    expect(result.violations).toContain('#T2 Unsur Kapan/Di mana/Siapa');
    expect(result.details.missingCoreInfo).toEqual(
      expect.arrayContaining(['Kapan', 'Di mana', 'Siapa']),
    );
  });

  it('fails freshness rule when event is older than 1 working day', () => {
    const result = evaluateAgainstPolicy(
      createInput({
        eventDate: new Date('2024-10-04T00:00:00.000Z'), // Friday
        nowJkt: new Date('2024-10-08T00:00:00.000Z'), // Tuesday -> 2 working days apart
      }),
    );

    expect(result.violations).toContain('#T4 Up to date');
    expect(result.details.eventDate).toBeInstanceOf(Date);
  });
});
