import { describe, expect, it } from 'vitest';
import {
  evaluateAgainstPolicy,
  splitInformativeSentences,
  type PolicyInput,
} from './policyLocal';

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
    sentenceCount: overrides.signals?.sentenceCount ?? estimateSentenceCount(textValue),
    ...overrides.signals,
  };

  const baseNow = overrides.nowJkt ?? new Date('2024-10-11T00:00:00.000Z');
  const baseUploadDate = overrides.uploadDate ?? baseNow;

  return {
    text: textValue,
    images: overrides.images ?? [
      { src: 'https://i.ibb.co/sample-one.jpg', alt: '' },
      { src: 'https://i.ibb.co/sample-two.jpg', alt: '' },
    ],
    eventDate: overrides.eventDate ?? new Date('2024-10-10T00:00:00.000Z'),
    uploadDate: baseUploadDate,
    signals: baseSignals,
    nowJkt: baseNow,
  };
}

describe('policyLocal', () => {
  it('passes T1-T5 for a complete Indonesian news article', () => {
    const result = evaluateAgainstPolicy(createInput());

    expect(result.violations).toEqual([]);
    expect(result.details.languageScore).toBeGreaterThanOrEqual(0.58);
    expect(result.details.sentenceCount).toBe(12);
    expect(result.details.coreInfoEvidence?.who.length).toBeGreaterThan(0);
    expect(result.details.coreInfoEvidence?.when.length).toBeGreaterThan(0);
    expect(result.details.coreInfoEvidence?.where.length).toBeGreaterThan(0);
  });

  it('flags T1 for text dominated by English and non-journalistic fragments', () => {
    const text = [
      'THE EVENT IS GREAT!!!',
      'This is an internal weekly activity.',
      'The team was in the office.',
      'And the meeting was very short.',
      'The agenda is the same.',
      'This report is written in English.',
      'The officer was present.',
      'The activity is now complete.',
      'There are no public outcomes.',
      'The team is ready.',
      'This is the final note.',
      'The end.',
    ].join(' ');
    const result = evaluateAgainstPolicy(createInput({ text }));

    expect(result.violations).toContain('#T1 Bahasa/Jurnalistik');
    expect(result.details.journalismIssues?.join(' ')).toContain('Bahasa Indonesia');
  });

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

  it('does not count titles, degrees, clock values, or decimals as sentences', () => {
    const sentences = splitInformativeSentences(
      'Dr. Budi Santoso, S.H. membuka rapat pada pukul 09.00 WIB. Nilai evaluasi meningkat menjadi 9.50 poin.',
    );

    expect(sentences).toHaveLength(2);
  });

  it('flags missing core info when kapan, di mana, siapa tidak ditemukan', () => {
    const result = evaluateAgainstPolicy(
      createInput({
        text: 'Kegiatan sosialisasi program berlangsung lancar sepanjang sesi. Agenda berfokus pada penyampaian materi layanan publik. Tim internal memastikan seluruh rangkaian berjalan interaktif.',
        eventDate: 'tanggal tidak valid',
      }),
    );

    expect(result.violations).toContain(
      '#T2 Unsur Nama Orang, Waktu, Lokasi (Tatap Muka Maupun Daring)',
    );
    expect(result.details.missingCoreInfo).toEqual(
      expect.arrayContaining(['Kapan', 'Di mana', 'Siapa']),
    );
  });

  it('recognizes a named person, exact time, and an online location', () => {
    const result = evaluateAgainstPolicy(
      createInput({
        text: 'Ketua Pengadilan Ahmad Fauzi membuka sosialisasi pada hari Rabu, 9 Oktober 2024 pukul 09.00 WIB. Kegiatan diselenggarakan secara daring melalui Zoom dan diikuti pegawai dari seluruh unit kerja.',
      }),
    );

    expect(result.violations).not.toContain(
      '#T2 Unsur Nama Orang, Waktu, Lokasi (Tatap Muka Maupun Daring)',
    );
    expect(result.details.coreInfoEvidence?.where.join(' ')).toMatch(/daring|Zoom/iu);
  });

  it('flags freshness rule when event lebih lama dari batas terhadap tanggal upload', () => {
    const result = evaluateAgainstPolicy(
      createInput({
        eventDate: new Date('2024-10-07T00:00:00.000Z'), // Monday
        uploadDate: new Date('2024-10-10T00:00:00.000Z'), // Thursday -> 2 working days gap
        nowJkt: new Date('2024-10-10T00:00:00.000Z'),
      }),
    );

    expect(result.violations).toContain('#T4 Up to date');
    expect(result.details.workingDaysToUpload).toBeGreaterThan(1);
  });

  it('flags freshness rule when event lebih lama dari batas terhadap tanggal konfirmasi', () => {
    const result = evaluateAgainstPolicy(
      createInput({
        eventDate: new Date('2024-10-03T00:00:00.000Z'), // Thursday
        uploadDate: new Date('2024-10-04T00:00:00.000Z'), // Friday
        nowJkt: new Date('2024-10-08T00:00:00.000Z'), // Tuesday -> 3 working days gap
      }),
    );

    expect(result.violations).toContain('#T4 Up to date');
    expect(result.details.workingDaysToEvaluation).toBeGreaterThan(2);
  });

  it('uses upload date as freshness reference when available', () => {
    const result = evaluateAgainstPolicy(
      createInput({
        eventDate: new Date('2024-10-01T00:00:00.000Z'), // Tuesday
        uploadDate: new Date('2024-10-02T00:00:00.000Z'), // Wednesday (within 1 working day)
        nowJkt: new Date('2024-10-03T00:00:00.000Z'), // Thursday (within 2 working days)
      }),
    );

    expect(result.violations).not.toContain('#T4 Up to date');
    expect(result.details.uploadDate).toBeInstanceOf(Date);
    expect(result.details.workingDaysToEvaluation).toBeLessThanOrEqual(2);
  });

  it('treats a Friday event uploaded on Monday as one working day', () => {
    const result = evaluateAgainstPolicy(
      createInput({
        eventDate: '2024-10-04', // Friday
        uploadDate: '2024-10-07', // Monday
        nowJkt: new Date('2024-10-07T10:00:00+07:00'),
      }),
    );

    expect(result.violations).not.toContain('#T4 Up to date');
    expect(result.details.workingDaysToUpload).toBe(1);
    expect(result.details.workingDaysToEvaluation).toBe(1);
  });

  it('flags a future event date as invalid freshness data', () => {
    const result = evaluateAgainstPolicy(
      createInput({
        eventDate: '2024-10-12',
        uploadDate: '2024-10-11',
        nowJkt: new Date('2024-10-11T10:00:00+07:00'),
      }),
    );

    expect(result.violations).toContain('#T4 Up to date');
    expect(result.details.freshnessIssues?.join(' ')).toContain(
      'setelah tanggal penilaian',
    );
  });

  it('flags routine-only activities as T5', () => {
    const routineText = [
      'Pada hari Jumat, 11 Oktober 2024, aparatur mengikuti apel pagi di halaman Kantor Pengadilan Bangkalan.',
      'Ketua Pengadilan Ahmad Fauzi memimpin kegiatan rutin tersebut.',
      'Para pegawai berdiri dalam barisan sesuai unit masing-masing.',
      'Kegiatan dimulai pukul 07.30 WIB.',
      'Petugas membacakan susunan acara kepada seluruh peserta.',
      'Pegawai mengikuti arahan dengan tertib.',
      'Apel pagi dilaksanakan seperti jadwal setiap minggu.',
      'Seluruh bagian mengikuti rangkaian kegiatan sampai selesai.',
      'Petugas kemudian memimpin doa bersama.',
      'Para peserta menjaga ketertiban selama kegiatan.',
      'Kegiatan berjalan lancar di halaman kantor.',
      'Setelah kegiatan selesai para pegawai kembali bekerja.',
    ].join(' ');
    const result = evaluateAgainstPolicy(createInput({ text: routineText }));

    expect(result.violations).toContain('#T5 Informatif');
    expect(result.details.routineKeywordsHit).toEqual(
      expect.arrayContaining(['apel pagi']),
    );
  });

  it('does not flag T5 when a routine activity contains a material news outcome', () => {
    const text = `${createInput().text} Setelah apel pagi, pengadilan menerima penghargaan pelayanan publik nasional.`;
    const result = evaluateAgainstPolicy(createInput({ text }));

    expect(result.violations).not.toContain('#T5 Informatif');
    expect(result.details.newsworthyKeywordsHit).toEqual(
      expect.arrayContaining(['penghargaan/prestasi']),
    );
  });
});
