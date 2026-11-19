import type { LeadData_NewAcquisition } from '@leads/shared/domain/sources/NewAcquisition';

import {
  enFaker,
  faker,
  getKanton,
  getName,
  getPhoneNumber,
  getStreet,
  getSubjectNumber,
  getUid,
  getZip,
} from './faker';

export function generateNewAcquisitionLead() {
  const [, , fullName] = getName();
  const companyName = faker.company.name();

  const lead: LeadData_NewAcquisition = {
    UIDNr: getUid(),
    SubNr: getSubjectNumber(),
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
    MobileG: getPhoneNumber(),
    Bemerkung: enFaker.lorem.sentence(4),
  };
  return lead;
}
