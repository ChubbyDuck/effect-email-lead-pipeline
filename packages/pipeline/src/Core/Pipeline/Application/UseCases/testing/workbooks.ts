import { Buffer } from 'node:buffer';

import { LEAD_SOURCE_HEADER__BUSINESS_CLOSURE } from '@leads/shared/domain/sources/BusinessClosure';
import { LEAD_SOURCE_HEADER__MUTATION } from '@leads/shared/domain/sources/Mutation';
import { LEAD_SOURCE_HEADER__NEW_ACQUISITION } from '@leads/shared/domain/sources/NewAcquisition';
import { utils, write } from 'xlsx';

export function workbook(header: readonly string[], rows: readonly Record<string, unknown>[]): Buffer {
  const book = utils.book_new();
  const sheet = utils.aoa_to_sheet([[...header], ...rows.map((row) => header.map((column) => row[column] ?? ''))]);
  utils.book_append_sheet(book, sheet, 'Leads');
  return Buffer.from(write(book, { type: 'buffer', bookType: 'xlsx' }));
}

export const sources = [
  {
    name: 'business-closure',
    type: 'business_closure',
    header: LEAD_SOURCE_HEADER__BUSINESS_CLOSURE,
    rows: [
      {
        UIDNr: 'CHE-123.456.789',
        SubNr: '1234567',
        AbrNr: '123.4567.89',
        Name: 'Alpenblick Hotel AG',
        Zusatzname: 'Mara Keller',
        Strasse: 'Bahnhofstrasse 12',
        Plz: 8001,
        Ort: 'Zürich',
        Kt: 'ZH',
        PrimTel: '+41 44 123 45 67',
        'E-Mail': 'mara.keller@example.ch',
        Pakete: 'PK 10 M, PK 10 F',
        'Gültig ab': '01-10-2026',
        Bemerkung: 'Betrieb wird Ende September geschlossen.',
      },
      {
        UIDNr: 'CHE-111.222.333',
        SubNr: '2345678',
        Name: 'Rigi Restaurant GmbH',
        Zusatzname: 'Lukas Meier',
        Strasse: 'Seestrasse 5',
        Plz: 6003,
        Ort: 'Luzern',
        Kt: 'LU',
        PrimTel: '+41 41 222 33 44',
        'E-Mail': 'lukas.meier@example.ch',
        'Gültig ab': '15-10-2026',
      },
    ],
  },
  {
    name: 'new-acquisition',
    type: 'new_acquisition',
    header: LEAD_SOURCE_HEADER__NEW_ACQUISITION,
    rows: [
      {
        UIDNr: 'CHE-987.654.321',
        SubNr: '7654321',
        Name: 'Seeblick Gastronomie GmbH',
        Zusatzname: 'Lena Meier',
        Strasse: 'Seestrasse 4',
        Plz: 6003,
        Ort: 'Luzern',
        Kt: 'LU',
        PrimTel: '+41 41 222 33 44',
        MobileP: '+41 78 222 33 44',
        Bemerkung: 'Neuer Betrieb am See.',
      },
      {
        UIDNr: 'CHE-222.333.444',
        SubNr: '8765432',
        Name: 'Marktgasse Bistro AG',
        Zusatzname: 'Noah Frei',
        Strasse: 'Marktgasse 8',
        Plz: 3011,
        Ort: 'Bern',
        Kt: 'BE',
        PrimTel: '+41 31 555 12 12',
        MobileP: '+41 79 555 12 12',
      },
    ],
  },
  {
    name: 'mutation',
    type: 'mutation',
    header: LEAD_SOURCE_HEADER__MUTATION,
    rows: [
      {
        Kanton: 'BE',
        Gegenwärtiger_Betriebsname: 'Altstadt Café',
        Gegenwärtiger_Wirtename: 'Jonas Frei',
        Strasse_Nr: 'Marktgasse 8',
        PLZ: 3011,
        Ort: 'Bern',
        Telefon: '+41 31 555 12 12',
        'E-Mail': 'jonas.frei@example.ch',
        Mutationsgrund: 'Wirtewechsel',
        Mutationsdatum: '27/09/26',
        Zukünftiger_Betriebsname: 'Altstadt Bistro',
        Rechtsform: 'GmbH',
        Zukünftiger_Wirtename: 'Nina Baumann',
        Anzahl_Gästezimmer: 0,
        Sitzplätze_Innen: 36,
        Sitzplätze_Aussen: 18,
        Erreichbarkeit_Name: 'Nina Baumann',
        Erreichbarkeit_Tel: '+41 79 555 12 12',
      },
      {
        Kanton: 'ZH',
        Gegenwärtiger_Betriebsname: 'Limmat Stube',
        Gegenwärtiger_Wirtename: 'Emil Weber',
        Strasse_Nr: 'Limmatquai 20',
        PLZ: 8001,
        Ort: 'Zürich',
        Telefon: '+41 44 444 55 66',
        'E-Mail': 'emil.weber@example.ch',
        Mutationsgrund: 'Neueröffnung',
        Mutationsdatum: '01/10/26',
        Zukünftiger_Betriebsname: 'Limmat Terrasse',
        Rechtsform: 'AG',
        Zukünftiger_Wirtename: 'Sofia Huber',
        Anzahl_Gästezimmer: 0,
        Sitzplätze_Innen: 48,
        Sitzplätze_Aussen: 24,
        Erreichbarkeit_Name: 'Sofia Huber',
        Erreichbarkeit_Tel: '+41 79 444 55 66',
      },
    ],
  },
] as const;
