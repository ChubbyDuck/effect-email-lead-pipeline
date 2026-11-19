import type { emailParserBuilder } from '#Infrastructure/Pipeline/EmailParser/mock/variants';
import type { excelSheetParserBuilder } from '#Infrastructure/Pipeline/ExcelSheetParser/mock/variants';
import type { guardBuilder } from '#Infrastructure/Pipeline/Guard/mock/variants';
import type { orderRepositoryBuilder } from '#Infrastructure/Pipeline/OrderRepository/mock/variants';
import type { queueBuilder } from '#Infrastructure/Pipeline/Queue/mock/variants';
import type { storageBuilder } from '#Infrastructure/Pipeline/Storage/mock/variants';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type BuilderContracts = [
  Assert<
    Equal<
      Parameters<typeof storageBuilder.read>[0],
      | 'failsWithFileNotRead'
      | 'succeedsWithEmptyBody'
      | 'succeedsWithMalformedJson'
      | 'succeedsWithoutLeads'
      | 'succeedsWithRejectedLead'
      | 'succeedsWithOnlyRejectedLeads'
      | 'succeedsWithLeadsNamedInKey'
      | 'succeedsAfterTwoSeconds'
      | 'succeeds'
    >
  >,
  Assert<
    Equal<
      Parameters<typeof orderRepositoryBuilder.store>[0],
      | 'failsWithAuthenticationFailed'
      | 'failsWithOrderStoreTimedOut'
      | 'failsWithOrderStoreFailed'
      | 'followsLeadScripts'
      | 'succeeds'
    >
  >,
  Assert<
    Equal<
      Parameters<typeof emailParserBuilder.parse>[0],
      'failsWithEmailNotParsed' | 'succeedsWithoutAttachments' | 'succeedsWithTwoAttachments' | 'succeeds'
    >
  >,
  Assert<Equal<Parameters<typeof guardBuilder.authorize>[0], 'failsWithUnauthorized' | 'succeeds'>>,
  Assert<
    Equal<
      Parameters<typeof storageBuilder.store>[0],
      'failsWithFileNotStored' | 'failsWithFileNotStoredForBroken' | 'failsWithFileNotStoredForBrokenLead' | 'succeeds'
    >
  >,
  Assert<
    Equal<
      Parameters<typeof storageBuilder.storeOrSkip>[0],
      'failsWithFileNotStored' | 'failsWithFileNotStoredForBroken' | 'failsWithFileNotStoredOnce' | 'skips' | 'succeeds'
    >
  >,
  Assert<Equal<Parameters<typeof storageBuilder.delete>[0], 'failsWithFileNotDeleted' | 'succeeds'>>,
  Assert<Equal<keyof typeof queueBuilder, 'pushBatch'>>,
  Assert<
    Equal<
      Parameters<typeof queueBuilder.pushBatch>[0],
      | 'failsWithMessageBatchNotPushed'
      | 'failsWithMessageBatchNotPushedForBrokenLead'
      | 'succeedsAfterTwoMessageBatchNotPushedFailures'
      | 'succeeds'
    >
  >,
  Assert<
    Equal<
      Parameters<typeof excelSheetParserBuilder.parse>[0],
      | 'failsWithNotAnExcelDocument'
      | 'failsWithWorkbookHasNoSheets'
      | 'failsWithExcelSheetNotParsed'
      | 'succeedsWithUnknownHeader'
      | 'succeedsWithOnlyRejectedRows'
      | 'succeedsWithRejectedRow'
      | 'succeedsWithTwoLeads'
      | 'succeedsWithElevenLeads'
      | 'succeeds'
    >
  >,
];
