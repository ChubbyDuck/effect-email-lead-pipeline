import type { LeadData_BusinessClosure } from '@leads/shared/domain/sources/BusinessClosure';
import { format, parse } from 'date-fns';

import {
  enFaker,
  faker,
  getBillingNumber,
  getBundle,
  getEmail,
  getKanton,
  getName,
  getPhoneNumber,
  getStreet,
  getSubjectNumber,
  getUid,
  getZip,
} from './faker';

export function generateBusinessClosureLead() {
  const [firstName, lastName, fullName] = getName();
  const companyName = faker.company.name();

  const lead: LeadData_BusinessClosure = {
    UIDNr: getUid(),
    SubNr: getSubjectNumber(),
    AbrNr: getBillingNumber(),
    Name: companyName,
    Zusatzname: fullName,
    AdrZusatz: companyName,
    Strasse: getStreet(),
    Plz: getZip(),
    Ort: faker.location.city(),
    Kt: getKanton(),
    PrimTel: getPhoneNumber(),
    KontTel: getPhoneNumber(),
    TelP: getPhoneNumber(),
    TelG: getPhoneNumber(),
    MobileP: getPhoneNumber(),
    'E-Mail': getEmail(firstName, lastName),
    Pakete: getBundle(),
    'Gültig ab': format(
      faker.date.between({ from: parse('2020-01-01', 'yyyy-MM-dd', new Date()), to: new Date() }),
      'dd-MM-yyyy'
    ),
    Bemerkung: enFaker.lorem.sentence(4),
  };
  return lead;
}
