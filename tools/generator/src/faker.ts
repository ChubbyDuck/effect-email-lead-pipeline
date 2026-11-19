import { de_CH, en, Faker } from '@faker-js/faker';

import { bundle, kantons, zipCodes } from './constants';

export const faker = new Faker({ locale: [de_CH] });

export const enFaker = new Faker({ locale: [en] });

const digits = (count: number) => faker.string.numeric(count);

export function getName() {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  return [firstName, lastName, `${firstName} ${lastName}`] as const;
}

/** A missing value in the real exports is the text `K.A`, so a share of the generated cells carries it too. */
export function getEmail(firstName: string, lastName: string) {
  const domain = enFaker.internet.domainName();
  const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${domain}`;
  return faker.helpers.arrayElement([email, 'K.A']);
}

export function getPhoneNumber() {
  return faker.helpers.arrayElement([faker.phone.number({ style: 'international' }), 'K.A']);
}

export function getStreet() {
  return `${faker.location.street()}, ${faker.number.int({ min: 1, max: 200 })}`;
}

export const getZip = () => faker.helpers.arrayElement(zipCodes);

export const getKanton = () => faker.helpers.arrayElement(kantons);

export const getBundle = () => faker.helpers.arrayElement(bundle);

/** `CHE-123.456.789` */
export const getUid = () => `CHE-${digits(3)}.${digits(3)}.${digits(3)}`;

export const getSubjectNumber = () => digits(7);

/** `123.4567.89` */
export const getBillingNumber = () => `${digits(3)}.${digits(4)}.${digits(2)}`;
