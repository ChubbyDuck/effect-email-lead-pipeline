import type { LeadData_Mutation } from '@leads/shared/domain/sources/Mutation';
import { format } from 'date-fns';

import { enFaker, faker, getEmail, getKanton, getName, getPhoneNumber, getStreet, getZip } from './faker';

export function generateMutationLead() {
  const [firstName, lastName, fullName] = getName();
  const [, , futureOwnerName] = getName();
  const [, , contactName] = getName();

  const zip = getZip();
  const city = faker.location.city();

  const lead: LeadData_Mutation = {
    Kanton: getKanton(),
    Gegenwärtiger_Betriebsname: faker.company.name(),
    Gegenwärtiger_Wirtename: fullName,
    Strasse_Nr: getStreet(),
    Postfach: '',
    PLZ: zip,
    Ort: city,
    Telefon: getPhoneNumber(),
    www: faker.helpers.arrayElement([enFaker.internet.url(), '.']),
    'E-Mail': getEmail(firstName, lastName),
    Mutationsgrund: faker.helpers.arrayElement(['Neueröffnung', 'Wirtewechsel', 'Wiedereröffnung']),
    Mutationsdatum: faker.helpers.arrayElement([format(faker.date.recent({ days: 365 }), 'dd/MM/yy'), 'unbekannt']),
    Zukünftiger_Betriebsname: faker.company.name(),
    Rechtsform: faker.helpers.arrayElement(['EF', 'GmbH', 'AG', 'Kollektivgesellschaft', 'Einzelunternehmen']),
    Zukünftiger_Wirtename: futureOwnerName,
    Anzahl_Gästezimmer: 0,
    Sitzplätze_Innen: faker.number.int({ min: 1, max: 100 }),
    Sitzplätze_Aussen: faker.number.int({ min: 1, max: 200 }),
    Erreichbarkeit_Name: contactName,
    Erreichbarkeit_Strasse: getStreet(),
    Erreichbarkeit_PLZ_Ort: `${zip} ${city}`,
    Erreichbarkeit_Tel: getPhoneNumber(),
  };
  return lead;
}
