/**
 * Bilingual copy for the settings section.
 *
 * Every other admin screen in this portal is written in Arabic inline, which
 * works because every reader of those screens is a municipal clerk in Lebanon.
 * Settings is the one section that does not hold: it is where a vendor, an
 * auditor, or a consultant configures a deployment, and those readers are not
 * reliably Arabic-first. The `[locale]` segment already exists in the route and
 * the header already switches it — until now nothing downstream read it.
 *
 * A plain typed object rather than a translation library. There are two
 * languages, both known at build time, and one section using them; `next-intl`
 * or `i18next` would add a provider, a loader and a message-extraction step to
 * buy pluralisation and interpolation this copy does not need. The type is the
 * enforcement — a key added to `ar` and forgotten in `en` fails the build.
 *
 * Direction is *not* handled here. `TenantLayout` puts `dir="rtl"` on `<html>`
 * for the Arabic locale, so the whole tree already flips; components stay
 * correct by using logical properties (`ps-*`, `text-start`, `border-e`) rather
 * than by asking which language they are in. The one thing that does not flip
 * is data that is always Latin — a phone number, an IBAN, a currency code —
 * and those carry `dir="ltr"` at the input.
 */

export type SettingsLocale = 'ar' | 'en';

/** The shape both bundles must fill. `ar` is the source of truth for keys. */
export interface SettingsCopy {
  page: {
    title: string;
    subtitle: string;
  };
  nav: {
    label: string;
    profile: string;
    finance: string;
    numbering: string;
    cadastre: string;
    security: string;
    backup: string;
    users: string;
  };
  common: {
    save: string;
    saving: string;
    saved: string;
    discard: string;
    cancel: string;
    optional: string;
    required: string;
    loadError: string;
    saveError: string;
    unsavedChanges: string;
    notConnected: string;
    notConnectedHint: string;
    storedLocally: string;
  };
  profile: {
    title: string;
    description: string;
    identityHeading: string;
    identityHint: string;
    nameAr: string;
    nameArHint: string;
    nameEn: string;
    nameEnHint: string;
    contactHeading: string;
    contactHint: string;
    phone: string;
    phoneHint: string;
    whatsapp: string;
    whatsappHint: string;
    email: string;
    website: string;
    regionHeading: string;
    councilDecisionRef: string;
    regionHint: string;
    governorate: string;
    district: string;
    town: string;
    officeHeading: string;
    officeHint: string;
    officeHours: string;
    officeHoursPlaceholder: string;
    officeAddress: string;
    officeAddressPlaceholder: string;
    logoHeading: string;
    logoHint: string;
    logoAlt: string;
    logoEmpty: string;
    logoUpload: string;
    logoReplace: string;
    logoRemove: string;
    logoTooLarge: string;
    logoWrongType: string;
    logoConstraints: string;
    logoDropHint: string;
  };
  finance: {
    title: string;
    description: string;
    defaultsHeading: string;
    defaultsHint: string;
    defaultFrequency: string;
    defaultFrequencyHint: string;
    dueDays: string;
    dueDaysHint: string;
    priceDisplay: string;
    priceDisplayHint: string;
    priceDisplayCompact: string;
    priceDisplayExact: string;
    rateHeading: string;
    rateHint: string;
    defaultRate: string;
    defaultRateHint: string;
    rateAppliesTo: string;
    ratePreview: string;
    ratePreviewBase: string;
    ratePreviewCharge: string;
    ratePreviewTotal: string;
    currencyHeading: string;
    currencyHint: string;
    baseCurrency: string;
    baseCurrencyHint: string;
    secondaryCurrency: string;
    secondaryCurrencyHint: string;
    secondaryNone: string;
    exchangeRate: string;
    exchangeRateHint: string;
    exchangeRateUnit: string;
    exchangeRateUpdated: string;
    exchangeRateNever: string;
    conversionPreview: string;
    whishHeading: string;
    whishHint: string;
    whishNumber: string;
    invalidRate: string;
    invalidDueDays: string;
    invalidExchange: string;
  };
  numbering: {
    title: string;
    description: string;
    heading: string;
    hint: string;
    prefix: string;
    prefixHint: string;
    nextNumber: string;
    nextNumberHint: string;
    padding: string;
    paddingHint: string;
    document: string;
    preview: string;
    previewHint: string;
    previewNext: string;
    previewAfter: string;
    documents: Record<SequenceKey, string>;
    documentHints: Record<SequenceKey, string>;
    invalidNext: string;
    invalidPadding: string;
    collision: string;
  };
  security: {
    title: string;
    description: string;
    designOnly: string;
    designOnlyHint: string;
    credentialsHeading: string;
    credentialsHint: string;
    currentEmail: string;
    newEmail: string;
    changeEmail: string;
    passwordHeading: string;
    passwordHint: string;
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
    changePassword: string;
    passwordMismatch: string;
    strength: string;
    strengthWeak: string;
    strengthFair: string;
    strengthStrong: string;
    verifyHeading: string;
    verifyHint: string;
    stepEdit: string;
    stepEditHint: string;
    stepConfirm: string;
    stepConfirmHint: string;
    stepApply: string;
    stepApplyHint: string;
    statePending: string;
    stateWaiting: string;
    twoFactorHeading: string;
    twoFactorHint: string;
    twoFactorOff: string;
    twoFactorEnable: string;
    twoFactorApp: string;
    twoFactorAppHint: string;
    twoFactorCode: string;
    historyHeading: string;
    historyHint: string;
    historySample: string;
    historySampleHint: string;
    colWhen: string;
    colIp: string;
    colDevice: string;
    colLocation: string;
    colResult: string;
    resultSuccess: string;
    resultFailed: string;
  };
  backup: {
    title: string;
    description: string;
    manualHeading: string;
    manualHint: string;
    backupNow: string;
    backingUp: string;
    includes: string;
    lastBackup: string;
    neverBackedUp: string;
    backupDone: string;
    backupFailed: string;
    partial: string;
    scheduleHeading: string;
    scheduleHint: string;
    frequency: string;
    frequencyOff: string;
    frequencyDaily: string;
    frequencyWeekly: string;
    frequencyMonthly: string;
    timeOfDay: string;
    dayOfWeek: string;
    dayOfMonth: string;
    keepCopies: string;
    keepCopiesHint: string;
    nextRun: string;
    nextRunNever: string;
    scheduleNotRun: string;
    restoreHeading: string;
    restoreHint: string;
    dropZone: string;
    dropZoneHint: string;
    browse: string;
    wrongFormat: string;
    reading: string;
    archiveContents: string;
    archiveEmpty: string;
    unreadableArchive: string;
    noManifest: string;
    archiveIncomplete: string;
    foreignArchive: string;
    restoreBlocked: string;
    restoreBlockedWhy: string;
    csvNotRestorable: string;
    snapshotHeading: string;
    snapshotHint: string;
    downloadSnapshot: string;
    snapshotDropZone: string;
    snapshotDropHint: string;
    notASnapshot: string;
    dryRun: string;
    dryRunHint: string;
    dryRunDone: string;
    dryRunResult: string;
    restoreDone: string;
    restoreFailed: string;
    restoreWarning: string;
    restoreWarningWhy: string;
    typeTenant: string;
    colTable: string;
    colRemoved: string;
    colWritten: string;
    restoreSelected: string;
    restoreDisabled: string;
    clearFile: string;
    historyHeading: string;
    historyHint: string;
    historyEmpty: string;
    colWhen: string;
    colAction: string;
    colScope: string;
    colSize: string;
    colOutcome: string;
    actionBackup: string;
    actionRestore: string;
    outcomeOk: string;
    outcomeFailed: string;
    tables: Record<string, string>;
  };
  cadastre: {
    title: string;
    heading: string;
    hint: string;
    replaceWarning: string;
    replaceWarningWhy: string;
    upload: string;
    uploading: string;
    dropHint: string;
    constraints: string;
    wrongFormat: string;
    imported: string;
    failed: string;
    parcelsImported: string;
    linesImported: string;
    parcelsSkipped: string;
    reloadMapHint: string;
  };
  users: {
    title: string;
    description: string;
    heading: string;
    hint: string;
    addAccount: string;
    search: string;
    colName: string;
    colEmail: string;
    colRole: string;
    colStatus: string;
    colActions: string;
    statusActive: string;
    statusSuspended: string;
    suspend: string;
    reactivate: string;
    empty: string;
    emptySearch: string;
    loadError: string;
    rolesHeading: string;
    rolesHint: string;
    roleUnavailable: string;
    roleUnavailableHint: string;
    roleNames: Record<RoleKey, string>;
    roleDuties: Record<RoleKey, string>;
    newAccount: string;
    newAccountHint: string;
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    passwordHint: string;
    role: string;
    create: string;
    creating: string;
    created: string;
    createFailed: string;
    statusChanged: string;
    incomplete: string;
  };
}

/**
 * The municipal roles this portal names, and how each maps onto the backend.
 *
 * Every key here now maps to a real `StaffRole` value. Accountant, collector
 * and clerk spent a while named but unassignable, because naming a role is
 * cheap and the two things that make it real are not: a Postgres enum
 * migration, and a decision about what it may do at every `@Roles()` guard.
 * Both have since landed, so the `null` case is gone — but the type keeps its
 * `| null` so that the next role someone wants to name can be listed here as
 * unavailable rather than silently offered before its permissions exist.
 */
export const ROLE_KEYS = [
  'admin',
  'collector',
  'accountant',
  'inspector',
  'clerk',
  'auditor',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const ROLE_BACKEND_VALUE: Record<RoleKey, string | null> = {
  admin: 'SUPER_ADMIN',
  collector: 'COLLECTOR',
  accountant: 'ACCOUNTANT',
  inspector: 'FIELD_INSPECTOR',
  clerk: 'ADMINISTRATIVE_OFFICER',
  auditor: 'AUDITOR',
};

/** Backend enum value → the catalogue entry that names it. */
export function roleKeyFor(backendRole: string): RoleKey | undefined {
  return ROLE_KEYS.find((key) => ROLE_BACKEND_VALUE[key] === backendRole);
}

/** The documents this portal issues a reference number for. */
export const SEQUENCE_KEYS = [
  'invoice',
  'serviceOrder',
  'permit',
  'taxReceipt',
  'refund',
] as const;
export type SequenceKey = (typeof SEQUENCE_KEYS)[number];

/** The currencies a Lebanese municipality actually quotes in. */
export const CURRENCIES = ['LBP', 'USD', 'EUR'] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

export const CURRENCY_NAMES: Record<SettingsLocale, Record<CurrencyCode, string>> = {
  ar: { LBP: 'ليرة لبنانية (ل.ل)', USD: 'دولار أميركي ($)', EUR: 'يورو (€)' },
  en: { LBP: 'Lebanese pound (LBP)', USD: 'US dollar (USD)', EUR: 'Euro (EUR)' },
};

const AR: SettingsCopy = {
  page: {
    title: 'إعدادات البلدية',
    subtitle: 'الملف الشخصي، المالية، الترقيم، الأمان، والمستخدمون',
  },
  nav: {
    label: 'أقسام الإعدادات',
    profile: 'الملف الشخصي للبلدية',
    finance: 'المالية',
    numbering: 'تسلسل الترقيم',
    cadastre: 'السجل العقاري',
    security: 'الأمان',
    backup: 'النسخ الاحتياطي والاستعادة',
    users: 'المستخدمون والأدوار',
  },
  common: {
    save: 'حفظ التغييرات',
    saving: 'جارٍ الحفظ…',
    saved: 'تم حفظ الإعدادات.',
    discard: 'تراجع',
    cancel: 'إلغاء',
    optional: 'اختياري',
    required: 'إلزامي',
    loadError: 'تعذّر تحميل الإعدادات.',
    saveError: 'تعذّر حفظ الإعدادات.',
    unsavedChanges: 'لديك تغييرات غير محفوظة.',
    notConnected: 'محفوظ على هذا المتصفح',
    notConnectedHint:
      'سجل النسخ يخصّ هذا الجهاز — الأرشيف نُزّل إليه، فلا يظهر لموظف آخر. باقي الإعدادات محفوظة على الخادم ويراها الجميع.',
    storedLocally: 'محفوظ محلياً',
  },
  profile: {
    title: 'الملف الشخصي للبلدية',
    description: 'الاسم والشعار وبيانات التواصل التي يظهرها البوابة للمواطنين.',
    identityHeading: 'هوية البلدية',
    identityHint: 'الاسم كما يُطبع على الإيصالات والمستندات الرسمية.',
    nameAr: 'اسم البلدية (عربي)',
    nameArHint: 'مثال: بلدية البازورية',
    nameEn: 'اسم البلدية (إنكليزي)',
    nameEnHint: 'يُستخدم في المستندات والمراسلات باللغة الإنكليزية.',
    contactHeading: 'بيانات التواصل',
    contactHint: 'تُطبع على الإيصالات ويراها المواطن في صفحة الدفع.',
    phone: 'الهاتف',
    phoneHint: 'الرقم العام للبلدية، يُطبع على كل إيصال.',
    whatsapp: 'واتساب',
    whatsappHint:
      'حساب المكتب. يُطبع على الإيصال ليردّ عليه المواطن — ولا يجعل رابط wa.me يُرسل من هذا الرقم.',
    email: 'البريد الإلكتروني',
    website: 'الموقع الإلكتروني',
    regionHeading: 'الموقع الإداري',
    councilDecisionRef: 'قرار المجلس البلدي لاعتماد الترقيم',
    regionHint: 'المحافظة والقضاء والبلدة كما ترد في السجلات الرسمية.',
    governorate: 'المحافظة',
    district: 'القضاء',
    town: 'البلدة',
    officeHeading: 'دوام المكتب',
    officeHint: 'يظهر للمواطن الذي يختار الدفع نقداً في البلدية.',
    officeHours: 'ساعات الدوام',
    officeHoursPlaceholder: 'الاثنين–الجمعة، ٨:٠٠–١٤:٠٠',
    officeAddress: 'عنوان المكتب',
    officeAddressPlaceholder: 'الطابق الأول، مبنى البلدية، الساحة العامة',
    logoHeading: 'الشعار الرسمي',
    logoHint: 'يظهر في ترويسة البوابة وعلى المستندات المطبوعة.',
    logoAlt: 'شعار البلدية',
    logoEmpty: 'لا شعار بعد',
    logoUpload: 'رفع شعار',
    logoReplace: 'استبدال',
    logoRemove: 'إزالة',
    logoTooLarge: 'حجم الصورة يتجاوز الحد المسموح.',
    logoWrongType: 'الملف ليس صورة.',
    logoConstraints: 'PNG أو SVG أو JPG — حتى ٥٠٠ كيلوبايت.',
    logoDropHint: 'أو اسحب الملف إلى هنا',
  },
  finance: {
    title: 'المالية',
    description: 'القيم الافتراضية للفواتير الجديدة، ونسبة الرسم، وإدارة العملات.',
    defaultsHeading: 'الإعدادات الافتراضية',
    defaultsHint: 'تُطبَّق على كل فاتورة جديدة، ويمكن تعديلها عند الإصدار.',
    defaultFrequency: 'دورية الرسم الافتراضية',
    defaultFrequencyHint: 'الدورية المقترحة في نافذة إصدار رسم جديد.',
    dueDays: 'مهلة السداد (أيام)',
    dueDaysHint: 'عدد الأيام بين إصدار الفاتورة وتاريخ استحقاقها.',
    priceDisplay: 'عرض المبالغ',
    priceDisplayHint: 'كيف تُعرض المبالغ الكبيرة في الجداول واللوحات.',
    priceDisplayCompact: 'مختصر (١.٢٥ مليون ل.ل)',
    priceDisplayExact: 'كامل (1,250,000 ل.ل)',
    rateHeading: 'نسبة الرسم الافتراضية',
    rateHint: 'النسبة المضافة إلى مبلغ الفاتورة ما لم تُحدَّد نسبة أخرى.',
    defaultRate: 'النسبة (%)',
    defaultRateHint: 'من 0 إلى 100. اتركها صفراً إن كانت الرسوم بمبالغ مقطوعة.',
    rateAppliesTo: 'تُطبَّق على الفواتير الجديدة فقط — الفواتير الصادرة لا تتغيّر.',
    ratePreview: 'مثال',
    ratePreviewBase: 'المبلغ الأساسي',
    ratePreviewCharge: 'الرسم المضاف',
    ratePreviewTotal: 'الإجمالي',
    currencyHeading: 'العملات وسعر الصرف',
    currencyHint: 'العملة الأساسية للسجلات، وعملة ثانوية اختيارية للعرض.',
    baseCurrency: 'العملة الأساسية',
    baseCurrencyHint: 'عملة القيد والإيصالات. تغييرها لا يحوّل الأرصدة القائمة.',
    secondaryCurrency: 'العملة الثانوية',
    secondaryCurrencyHint: 'تُعرض بجانب المبلغ الأساسي عند الاقتضاء.',
    secondaryNone: 'بلا عملة ثانوية',
    exchangeRate: 'سعر الصرف',
    exchangeRateHint: 'كم وحدة من العملة الأساسية تعادل وحدة واحدة من الثانوية.',
    exchangeRateUnit: 'لكل وحدة',
    exchangeRateUpdated: 'آخر تحديث',
    exchangeRateNever: 'لم يُحدَّث بعد',
    conversionPreview: 'المعادلة',
    whishHeading: 'الدفع عبر Whish Money',
    whishHint: 'الرقم الذي يحوّل إليه المواطن. يبقى الخيار مخفياً إن تُرك فارغاً.',
    whishNumber: 'رقم Whish Money',
    invalidRate: 'النسبة يجب أن تكون بين 0 و100.',
    invalidDueDays: 'مهلة السداد يجب أن تكون عدداً صحيحاً بين 0 و365 يوماً.',
    invalidExchange: 'سعر الصرف يجب أن يكون أكبر من صفر.',
  },
  numbering: {
    title: 'تسلسل الترقيم',
    description: 'صيغة الأرقام المرجعية للمستندات التي تصدرها البلدية.',
    heading: 'تسلسلات المستندات',
    hint: 'لكل نوع مستند بادئته وعدّاده الخاص، فلا يتداخل ترقيم نوع مع آخر.',
    prefix: 'البادئة',
    prefixHint: 'حروف لاتينية وأرقام وشرطات، مثل MUN-',
    nextNumber: 'الرقم التالي',
    nextNumberHint: 'رقم أول مستند يصدر بعد الحفظ.',
    padding: 'خانات التصفير',
    paddingHint: 'طول الرقم مع الأصفار على اليسار — 4 تعطي 0042.',
    document: 'المستند',
    preview: 'المعاينة',
    previewHint: 'هكذا يظهر الرقم على المستند.',
    previewNext: 'التالي',
    previewAfter: 'ثم',
    documents: {
      invoice: 'فاتورة بلدية',
      serviceOrder: 'أمر خدمة',
      permit: 'رخصة رسمية',
      taxReceipt: 'إيصال رسم',
      refund: 'مذكرة استرداد',
    },
    documentHints: {
      invoice: 'المطالبات المرسلة إلى المواطنين.',
      serviceOrder: 'أوامر العمل الصادرة إلى الأقسام والمتعهدين.',
      permit: 'رخص البناء والإشغال والأنشطة.',
      taxReceipt: 'الإيصالات المسلّمة عند القبض.',
      refund: 'المبالغ المعادة إلى المواطن.',
    },
    invalidNext: 'الرقم التالي يجب أن يكون عدداً صحيحاً أكبر من صفر.',
    invalidPadding: 'خانات التصفير يجب أن تكون بين 1 و12.',
    collision: 'هذه البادئة مستخدمة في تسلسل آخر — الأرقام ستتشابه.',
  },
  security: {
    title: 'الأمان',
    description: 'بيانات الدخول، التحقق بخطوتين، وسجل محاولات الدخول.',
    designOnly: 'تصميم واجهة فقط',
    designOnlyHint:
      'هذا القسم يعرض الشكل والتدفّق المقصودين. الأزرار لا تنفّذ تغييراً بعد — تغيير البريد وكلمة المرور والتحقق بخطوتين تحتاج نقاط خدمة على الخادم.',
    credentialsHeading: 'البريد الإلكتروني',
    credentialsHint: 'البريد الذي تسجّل الدخول به وتصلك عليه رسائل التحقق.',
    currentEmail: 'البريد الحالي',
    newEmail: 'البريد الجديد',
    changeEmail: 'تغيير البريد',
    passwordHeading: 'كلمة المرور',
    passwordHint: 'اختر كلمة طويلة لم تستخدمها في مكان آخر.',
    currentPassword: 'كلمة المرور الحالية',
    newPassword: 'كلمة المرور الجديدة',
    confirmPassword: 'تأكيد كلمة المرور',
    changePassword: 'تغيير كلمة المرور',
    passwordMismatch: 'الكلمتان غير متطابقتين.',
    strength: 'القوة',
    strengthWeak: 'ضعيفة',
    strengthFair: 'مقبولة',
    strengthStrong: 'قوية',
    verifyHeading: 'خطوات التحقق',
    verifyHint: 'أي تغيير على بيانات الدخول يمرّ بهذه الخطوات الثلاث.',
    stepEdit: 'إدخال التغيير',
    stepEditHint: 'تكتب القيمة الجديدة هنا.',
    stepConfirm: 'تأكيد الهوية',
    stepConfirmHint: 'رسالة إلى بريدك، أو رمز من تطبيق المصادقة إن كان مفعّلاً.',
    stepApply: 'سريان التغيير',
    stepApplyHint: 'يُطبَّق بعد التأكيد، وتُنهى الجلسات الأخرى.',
    statePending: 'بانتظار التنفيذ',
    stateWaiting: 'لم تبدأ',
    twoFactorHeading: 'التحقق بخطوتين',
    twoFactorHint: 'رمز من تطبيق مصادقة إضافةً إلى كلمة المرور.',
    twoFactorOff: 'غير مفعّل',
    twoFactorEnable: 'تفعيل',
    twoFactorApp: 'تطبيق المصادقة',
    twoFactorAppHint: 'Google Authenticator أو Authy أو ما يماثلهما.',
    twoFactorCode: 'الرمز المكوّن من ٦ أرقام',
    historyHeading: 'سجل الدخول',
    historyHint: 'آخر محاولات الدخول إلى هذا الحساب.',
    historySample: 'بيانات عيّنة',
    historySampleHint:
      'الصفوف أدناه توضيحية لعرض شكل الجدول — لا تُقرأ كسجل دخول فعلي إلى أن يوصل القسم بالخادم.',
    colWhen: 'التاريخ والوقت',
    colIp: 'عنوان IP',
    colDevice: 'الجهاز',
    colLocation: 'الموقع',
    colResult: 'النتيجة',
    resultSuccess: 'ناجحة',
    resultFailed: 'فاشلة',
  },
  backup: {
    title: 'النسخ الاحتياطي والاستعادة',
    description: 'تنزيل نسخة من بيانات البلدية، وجدولة النسخ، واستعادتها.',
    manualHeading: 'نسخة احتياطية الآن',
    manualHint: 'تُصدَّر الجداول ملفات CSV مجمّعة في أرشيف ZIP واحد يُنزَّل على جهازك.',
    backupNow: 'أنشئ نسخة الآن',
    backingUp: 'جارٍ التصدير…',
    includes: 'الجداول المشمولة',
    lastBackup: 'آخر نسخة',
    neverBackedUp: 'لم تُنشأ نسخة بعد',
    backupDone: 'تم إنشاء النسخة وتنزيلها.',
    backupFailed: 'تعذّر إنشاء النسخة.',
    partial: 'تعذّر تصدير بعض الجداول — الأرشيف ناقص.',
    scheduleHeading: 'النسخ التلقائي',
    scheduleHint: 'موعد تشغيل النسخ دون تدخّل.',
    frequency: 'التكرار',
    frequencyOff: 'معطّل',
    frequencyDaily: 'يومياً',
    frequencyWeekly: 'أسبوعياً',
    frequencyMonthly: 'شهرياً',
    timeOfDay: 'الساعة',
    dayOfWeek: 'يوم الأسبوع',
    dayOfMonth: 'يوم الشهر',
    keepCopies: 'عدد النسخ المحفوظة',
    keepCopiesHint: 'تُحذف الأقدم تلقائياً عند تجاوز العدد.',
    nextRun: 'التشغيل التالي',
    nextRunNever: 'لا تشغيل مجدول',
    scheduleNotRun: 'الجدولة محفوظة على الخادم، لكن لا توجد مهمة مجدولة تشغّلها بعد.',
    restoreHeading: 'الاستعادة',
    restoreHint: 'ارفع أرشيف ZIP من نسخة سابقة.',
    dropZone: 'اسحب ملف ZIP إلى هنا',
    dropZoneHint: 'أو اخترْه من جهازك',
    browse: 'اختيار ملف',
    wrongFormat: 'الملف ليس أرشيف ZIP.',
    reading: 'جارٍ القراءة…',
    archiveContents: 'محتويات الأرشيف',
    archiveEmpty: 'الأرشيف لا يحتوي على أي ملف CSV.',
    unreadableArchive: 'تعذّرت قراءة الملف كأرشيف ZIP سليم.',
    noManifest: 'لا يحتوي الأرشيف على ملف manifest.json — لا يمكن التحقق من مصدره أو تاريخه.',
    archiveIncomplete: 'الأرشيف ناقص؛ فشل تصدير:',
    foreignArchive: 'هذا الأرشيف يخصّ بلدية «{archive}» وأنت في «{current}».',
    restoreBlocked: 'الاستعادة غير ممكنة من هذا الأرشيف',
    restoreBlockedWhy:
      'الأرشيف تصدير لما تعرضه واجهة البرمجة لا لصفوف الجداول — يحتوي مثلاً الاسم الكامل والمجاميع المحسوبة، بينما جدول المستخدمين يحتاج الاسم الأول والأوسط والأخير والجنس وحجم الأسرة وغيرها. تحتاج الاستعادة إلى نقطة خدمة على الخادم وإلى تصدير بصيغة الجداول نفسها.',
    csvNotRestorable: 'هذا الأرشيف تقرير للقراءة ولا يمكن الاستعادة منه — استخدم «نسخة قابلة للاستعادة» أدناه.',
    snapshotHeading: 'نسخة قابلة للاستعادة',
    snapshotHint: 'ملف يحتوي صفوف الجداول كما هي، وهو الوحيد الذي يمكن إعادته إلى قاعدة البيانات.',
    downloadSnapshot: 'تنزيل نسخة قابلة للاستعادة',
    snapshotDropZone: 'اسحب ملف .json.gz إلى هنا',
    snapshotDropHint: 'أو اخترْه من جهازك',
    notASnapshot: 'الملف ليس نسخة قابلة للاستعادة (.json.gz).',
    dryRun: 'تجربة دون تنفيذ',
    dryRunHint: 'يتحقّق من الملف ويعرض ما سيحدث، دون أي تغيير.',
    dryRunDone: 'انتهت التجربة — راجع الأرقام قبل التنفيذ.',
    dryRunResult: 'نتيجة التجربة (لم يُنفَّذ أي تغيير)',
    restoreDone: 'تمت الاستعادة.',
    restoreFailed: 'تعذّرت الاستعادة.',
    restoreWarning: 'هذه العملية تستبدل بيانات البلدية بالكامل',
    restoreWarningWhy:
      'ستُحذف كل الصفوف الحالية وتحلّ محلها صفوف النسخة، في عملية واحدة لا يمكن التراجع عنها. اكتب «{tenant}» للتأكيد.',
    typeTenant: 'اكتب «{tenant}»',
    colTable: 'الجدول',
    colRemoved: 'سيُحذف',
    colWritten: 'سيُكتب',
    restoreSelected: 'تنفيذ الاستعادة',
    restoreDisabled: 'الاستعادة تحتاج نقطة خدمة على الخادم — غير متاحة بعد.',
    clearFile: 'إزالة الملف',
    historyHeading: 'سجل النسخ والاستعادة',
    historyHint: 'العمليات التي جرت من هذا المتصفح.',
    historyEmpty: 'لا عمليات بعد.',
    colWhen: 'التاريخ والوقت',
    colAction: 'العملية',
    colScope: 'النطاق',
    colSize: 'الحجم',
    colOutcome: 'النتيجة',
    actionBackup: 'نسخ احتياطي',
    actionRestore: 'استعادة',
    outcomeOk: 'ناجحة',
    outcomeFailed: 'فاشلة',
    tables: {
      citizens: 'المواطنون',
      staff: 'الموظفون',
      fees: 'الرسوم',
      payments: 'المدفوعات',
      zones: 'القطاعات',
      audit: 'سجل النشاطات',
      settings: 'الإعدادات',
    },
  },
  cadastre: {
    title: 'السجل العقاري',
    heading: 'حدود العقارات',
    hint: 'ملف GeoJSON الذي ترسم منه الخريطة العقارات وخطوط الحدود.',
    replaceWarning: 'الاستيراد يستبدل طبقة العقارات بالكامل',
    replaceWarningWhy:
      'يصبح الملف الجديد هو حدود عقارات البلدية، وكل ما ليس فيه يختفي عن الخريطة. عضوية القطاعات محفوظة برقم العقار، فالعقار الغائب عن الملف الجديد يفقد قطاعه.',
    upload: 'اختر ملف GeoJSON',
    uploading: 'جارٍ الاستيراد…',
    dropHint: 'أو اسحبه إلى هنا',
    constraints: '.geojson أو .json — مضلّعات العقارات وخطوط الحدود.',
    wrongFormat: 'الملف ليس بصيغة .geojson أو .json.',
    imported: 'تم استيراد السجل العقاري',
    failed: 'تعذّر الاستيراد.',
    parcelsImported: 'عقارات مستوردة',
    linesImported: 'خطوط حدودية',
    parcelsSkipped: 'تم تجاوزها',
    reloadMapHint: 'افتح الخريطة من جديد لرؤية الطبقة المحدّثة.',
  },
  users: {
    title: 'المستخدمون والأدوار',
    description: 'حسابات الموظفين وصلاحية كل منهم.',
    heading: 'الحسابات',
    hint: 'كل من يملك حق الدخول إلى لوحة الإدارة.',
    addAccount: 'حساب جديد',
    search: 'ابحث بالاسم أو البريد…',
    colName: 'الاسم',
    colEmail: 'البريد الإلكتروني',
    colRole: 'الدور',
    colStatus: 'الحالة',
    colActions: 'إجراءات',
    statusActive: 'فعّال',
    statusSuspended: 'موقوف',
    suspend: 'إيقاف',
    reactivate: 'إعادة تفعيل',
    empty: 'لا حسابات بعد.',
    emptySearch: 'لا نتائج مطابقة لبحثك.',
    loadError: 'تعذّر تحميل الحسابات.',
    rolesHeading: 'الأدوار المتاحة',
    rolesHint: 'ما يستطيع صاحب كل دور فعله داخل النظام.',
    roleUnavailable: 'غير متاح بعد',
    roleUnavailableHint:
      'هذا الدور غير موجود في قاعدة البيانات بعد — إضافته تحتاج ترحيلاً وتحديد صلاحياته على الخادم.',
    roleNames: {
      admin: 'مدير النظام',
      collector: 'جابي',
      accountant: 'محاسب',
      inspector: 'مفتّش ميداني',
      clerk: 'موظف إداري',
      auditor: 'مدقّق',
    },
    roleDuties: {
      admin: 'صلاحية كاملة: الموافقة النهائية، الإعدادات، وإدارة الحسابات.',
      collector: 'جباية الرسوم وتسجيل المقبوضات، دون تعديل سجل المواطنين.',
      accountant: 'إصدار الرسوم وتأكيد الدفعات ومتابعة التحصيل.',
      inspector: 'مراجعة الطلبات ميدانياً، دون الاطلاع على سجل النشاطات.',
      clerk: 'إدخال بيانات المواطنين وتحديثها، دون البتّ في الطلبات.',
      auditor: 'الاطلاع والمراجعة وتصدير البيانات، دون الموافقة النهائية.',
    },
    newAccount: 'إنشاء حساب جديد',
    newAccountHint: 'يستطيع صاحب الحساب الدخول فور إنشائه.',
    firstName: 'الاسم الأول',
    lastName: 'الكنية',
    email: 'البريد الإلكتروني',
    password: 'كلمة المرور',
    passwordHint: 'ثمانية أحرف على الأقل. سلّمها للموظف بوسيلة آمنة.',
    role: 'الدور',
    create: 'إنشاء الحساب',
    creating: 'جارٍ الإنشاء…',
    created: 'تم إنشاء الحساب.',
    createFailed: 'تعذّر إنشاء الحساب.',
    statusChanged: 'تم تحديث حالة الحساب.',
    incomplete: 'أكمل الحقول الإلزامية.',
  },
};

const EN: SettingsCopy = {
  page: {
    title: 'Municipality settings',
    subtitle: 'Profile, finance, numbering, security, and users',
  },
  nav: {
    label: 'Settings sections',
    profile: 'Municipality profile',
    finance: 'Finance',
    numbering: 'Numbering sequences',
    cadastre: 'Cadastre',
    security: 'Security',
    backup: 'Backup & restore',
    users: 'Users & roles',
  },
  common: {
    save: 'Save changes',
    saving: 'Saving…',
    saved: 'Settings saved.',
    discard: 'Discard',
    cancel: 'Cancel',
    optional: 'Optional',
    required: 'Required',
    loadError: 'Could not load settings.',
    saveError: 'Could not save settings.',
    unsavedChanges: 'You have unsaved changes.',
    notConnected: 'Kept in this browser',
    notConnectedHint:
      'This history is specific to this machine — the archive was downloaded here, so another member of staff will not see it. Every other setting is saved on the server.',
    storedLocally: 'Stored locally',
  },
  profile: {
    title: 'Municipality profile',
    description: 'The name, logo, and contact details the portal shows to citizens.',
    identityHeading: 'Identity',
    identityHint: 'The name as printed on receipts and official documents.',
    nameAr: 'Municipality name (Arabic)',
    nameArHint: 'For example: Municipality of Al-Bazourieh',
    nameEn: 'Municipality name (English)',
    nameEnHint: 'Used in English documents and correspondence.',
    contactHeading: 'Contact details',
    contactHint: 'Printed on receipts and shown to citizens on the payment page.',
    phone: 'Phone',
    phoneHint: 'The general phone number printed on every receipt.',
    whatsapp: 'WhatsApp',
    whatsappHint: 'Office account printed on receipts for citizen replies.',
    email: 'Email',
    website: 'Website',
    regionHeading: 'Administrative location',
    councilDecisionRef: 'Council decision adopting the numbering',
    regionHint: 'Governorate, district, and town as they appear in official records.',
    governorate: 'Governorate',
    district: 'District',
    town: 'Town',
    officeHeading: 'Office hours',
    officeHint: 'Shown to citizens who choose to pay in cash at the municipality.',
    officeHours: 'Opening hours',
    officeHoursPlaceholder: 'Mon–Fri, 08:00–14:00',
    officeAddress: 'Office address',
    officeAddressPlaceholder: 'First floor, municipality building, main square',
    logoHeading: 'Official logo',
    logoHint: 'Appears in the portal header and on printed documents.',
    logoAlt: 'Municipality logo',
    logoEmpty: 'No logo yet',
    logoUpload: 'Upload logo',
    logoReplace: 'Replace',
    logoRemove: 'Remove',
    logoTooLarge: 'The image is larger than the allowed size.',
    logoWrongType: 'That file is not an image.',
    logoConstraints: 'PNG, SVG, or JPG — up to 500 KB.',
    logoDropHint: 'or drag and drop',
  },
  finance: {
    title: 'Finance',
    description: 'Defaults for new invoices, the standard fee rate, and currency management.',
    defaultsHeading: 'Default settings',
    defaultsHint: 'Applied to every new invoice, and editable at the point of issue.',
    defaultFrequency: 'Default fee frequency',
    defaultFrequencyHint: 'Suggested frequency in the new fee modal.',
    dueDays: 'Payment term (days)',
    dueDaysHint: 'Days between issuing an invoice and its due date.',
    priceDisplay: 'Amount display',
    priceDisplayHint: 'How large figures are displayed in tables and summaries.',
    priceDisplayCompact: 'Compact (1.25M LBP)',
    priceDisplayExact: 'Full (1,250,000 LBP)',
    rateHeading: 'Default tax / fee rate',
    rateHint: 'Added to an invoice amount unless a different rate is given.',
    defaultRate: 'Rate (%)',
    defaultRateHint: '0 to 100. Leave at zero if fees are flat amounts.',
    rateAppliesTo: 'Applies to new invoices only — issued invoices do not change.',
    ratePreview: 'Example',
    ratePreviewBase: 'Base amount',
    ratePreviewCharge: 'Rate applied',
    ratePreviewTotal: 'Total',
    currencyHeading: 'Currencies and exchange rate',
    currencyHint: 'The currency records are kept in, plus an optional display currency.',
    baseCurrency: 'Base currency',
    baseCurrencyHint: 'The accounting and receipt currency. Changing it does not convert balances.',
    secondaryCurrency: 'Secondary currency',
    secondaryCurrencyHint: 'Displayed alongside the base amount where applicable.',
    secondaryNone: 'No secondary currency',
    exchangeRate: 'Exchange rate',
    exchangeRateHint: 'How many units of base currency equal one unit of secondary currency.',
    exchangeRateUnit: 'per unit',
    exchangeRateUpdated: 'Last updated',
    exchangeRateNever: 'Never updated',
    conversionPreview: 'Equivalent',
    whishHeading: 'Whish Money payments',
    whishHint: 'The number citizens transfer to. Left blank, the option is hidden from the payment page.',
    whishNumber: 'Whish Money number',
    invalidRate: 'The rate must be between 0 and 100.',
    invalidDueDays: 'The payment term must be a whole number between 0 and 365 days.',
    invalidExchange: 'The exchange rate must be greater than zero.',
  },
  numbering: {
    title: 'Numbering sequences',
    description: 'The reference-number format for each document the municipality issues.',
    heading: 'Document sequences',
    hint: 'Each document type has its own prefix and counter, so no two share a number.',
    prefix: 'Prefix',
    prefixHint: 'Latin letters, digits, and dashes — for example MUN-',
    nextNumber: 'Next number',
    nextNumberHint: 'The number the first document issued after saving will take.',
    padding: 'Zero-padding',
    paddingHint: 'Total digit length, zero-filled on the left — 4 gives 0042.',
    document: 'Document',
    preview: 'Preview',
    previewHint: 'How the reference will read on the document.',
    previewNext: 'Next',
    previewAfter: 'Then',
    documents: {
      invoice: 'Municipal invoice',
      serviceOrder: 'Service order',
      permit: 'Official permit',
      taxReceipt: 'Tax receipt',
      refund: 'Refund note',
    },
    documentHints: {
      invoice: 'Charges sent to citizens.',
      serviceOrder: 'Work orders issued to departments and contractors.',
      permit: 'Construction, occupancy, and activity permits.',
      taxReceipt: 'Receipts handed over when payment is taken.',
      refund: 'Amounts returned to a citizen.',
    },
    invalidNext: 'The next number must be a whole number greater than zero.',
    invalidPadding: 'Zero-padding must be between 1 and 12.',
    collision: 'Another sequence already uses this prefix — their numbers will look alike.',
  },
  security: {
    title: 'Security',
    description: 'Sign-in credentials, two-factor verification, and login history.',
    designOnly: 'Interface design only',
    designOnlyHint:
      'This section shows the intended shape and flow. The buttons do not change anything yet — email, password, and two-factor changes need server endpoints that do not exist.',
    credentialsHeading: 'Email address',
    credentialsHint: 'The address you sign in with and receive verification messages at.',
    currentEmail: 'Current email',
    newEmail: 'New email',
    changeEmail: 'Change email',
    passwordHeading: 'Password',
    passwordHint: 'Choose something long that you have not used elsewhere.',
    currentPassword: 'Current password',
    newPassword: 'New password',
    confirmPassword: 'Confirm password',
    changePassword: 'Change password',
    passwordMismatch: 'The two passwords do not match.',
    strength: 'Strength',
    strengthWeak: 'Weak',
    strengthFair: 'Fair',
    strengthStrong: 'Strong',
    verifyHeading: 'Verification steps',
    verifyHint: 'Every credential change goes through these three steps.',
    stepEdit: 'Enter the change',
    stepEditHint: 'You type the new value here.',
    stepConfirm: 'Confirm identity',
    stepConfirmHint: 'A message to your inbox, or a code from your authenticator app.',
    stepApply: 'Change takes effect',
    stepApplyHint: 'Applied after confirmation, and other sessions are signed out.',
    statePending: 'Pending implementation',
    stateWaiting: 'Not started',
    twoFactorHeading: 'Two-factor authentication',
    twoFactorHint: 'A code from an authenticator app in addition to your password.',
    twoFactorOff: 'Not enabled',
    twoFactorEnable: 'Enable',
    twoFactorApp: 'Authenticator app',
    twoFactorAppHint: 'Google Authenticator, Authy, or similar.',
    twoFactorCode: 'Six-digit code',
    historyHeading: 'Login history',
    historyHint: 'Recent sign-in attempts on this account.',
    historySample: 'Sample data',
    historySampleHint:
      'The rows below are illustrative, to show the shape of the table — do not read them as a real login log until this section is wired to the server.',
    colWhen: 'Date and time',
    colIp: 'IP address',
    colDevice: 'Device',
    colLocation: 'Location',
    colResult: 'Result',
    resultSuccess: 'Successful',
    resultFailed: 'Failed',
  },
  backup: {
    title: 'Backup & restore',
    description: 'Download a copy of the municipality data, schedule backups, and restore them.',
    manualHeading: 'Back up now',
    manualHint: 'Each table is exported as CSV and bundled into a single ZIP archive.',
    backupNow: 'Back up now',
    backingUp: 'Exporting…',
    includes: 'Tables included',
    lastBackup: 'Last backup',
    neverBackedUp: 'No backup taken yet',
    backupDone: 'Backup created and downloaded.',
    backupFailed: 'Could not create the backup.',
    partial: 'Some tables could not be exported — the archive is incomplete.',
    scheduleHeading: 'Automatic backups',
    scheduleHint: 'When backups should run without anyone asking.',
    frequency: 'Frequency',
    frequencyOff: 'Off',
    frequencyDaily: 'Daily',
    frequencyWeekly: 'Weekly',
    frequencyMonthly: 'Monthly',
    timeOfDay: 'Time',
    dayOfWeek: 'Day of week',
    dayOfMonth: 'Day of month',
    keepCopies: 'Copies to keep',
    keepCopiesHint: 'The oldest is deleted once the count is exceeded.',
    nextRun: 'Next run',
    nextRunNever: 'Nothing scheduled',
    scheduleNotRun: 'The schedule is saved on the server, but no scheduled job runs it yet.',
    restoreHeading: 'Restore',
    restoreHint: 'Upload a ZIP archive from an earlier backup.',
    dropZone: 'Drop a ZIP file here',
    dropZoneHint: 'or choose one from your computer',
    browse: 'Choose file',
    wrongFormat: 'That file is not a ZIP archive.',
    reading: 'Reading…',
    archiveContents: 'Archive contents',
    archiveEmpty: 'The archive contains no CSV files.',
    unreadableArchive: 'The file could not be read as a valid ZIP archive.',
    noManifest: 'This archive has no manifest.json — its origin and date cannot be verified.',
    archiveIncomplete: 'The archive is incomplete; these tables failed to export:',
    foreignArchive: 'This archive belongs to «{archive}» and you are in «{current}».',
    restoreBlocked: 'This archive cannot be restored from',
    restoreBlockedWhy:
      'The archive is an export of what the API returns, not of table rows — it holds a joined full name and computed totals, while the users table needs first, middle and last name, gender, household size and more. Restore needs both a server endpoint and an export in the shape of the tables.',
    csvNotRestorable: 'This archive is a read-only report and cannot be restored from — use the restorable snapshot below.',
    snapshotHeading: 'Restorable snapshot',
    snapshotHint: 'A file holding the table rows themselves — the only one that can be written back to the database.',
    downloadSnapshot: 'Download restorable snapshot',
    snapshotDropZone: 'Drop a .json.gz snapshot here',
    snapshotDropHint: 'or choose one from your computer',
    notASnapshot: 'That file is not a restorable snapshot (.json.gz).',
    dryRun: 'Rehearse',
    dryRunHint: 'Checks the file and reports what would happen, changing nothing.',
    dryRunDone: 'Rehearsal finished — check the numbers before running it.',
    dryRunResult: 'Rehearsal result (nothing was changed)',
    restoreDone: 'Restore complete.',
    restoreFailed: 'The restore failed.',
    restoreWarning: 'This replaces the municipality data entirely',
    restoreWarningWhy:
      'Every current row is deleted and replaced by the snapshot rows, in one operation that cannot be undone. Type «{tenant}» to confirm.',
    typeTenant: 'Type «{tenant}»',
    colTable: 'Table',
    colRemoved: 'Removed',
    colWritten: 'Written',
    restoreSelected: 'Run restore',
    restoreDisabled: 'Restore needs a server endpoint — not available yet.',
    clearFile: 'Remove file',
    historyHeading: 'Backup & restore history',
    historyHint: 'Operations run from this browser.',
    historyEmpty: 'Nothing yet.',
    colWhen: 'Date and time',
    colAction: 'Operation',
    colScope: 'Scope',
    colSize: 'Size',
    colOutcome: 'Outcome',
    actionBackup: 'Backup',
    actionRestore: 'Restore',
    outcomeOk: 'Successful',
    outcomeFailed: 'Failed',
    tables: {
      citizens: 'Citizens',
      staff: 'Staff',
      fees: 'Fees',
      payments: 'Payments',
      zones: 'Zones',
      audit: 'Activity log',
      settings: 'Settings',
    },
  },
  cadastre: {
    title: 'Cadastre',
    heading: 'Parcel geometry',
    hint: 'The GeoJSON the map draws parcels and boundary lines from.',
    replaceWarning: 'Importing replaces the whole parcel layer',
    replaceWarningWhy:
      "The new file becomes the municipality's parcel geometry; anything not in it stops appearing on the map. Sector membership is kept by parcel number, so a parcel missing from the new file loses its sector.",
    upload: 'Choose a GeoJSON file',
    uploading: 'Importing…',
    dropHint: 'or drag and drop',
    constraints: '.geojson or .json — parcel polygons and boundary lines.',
    wrongFormat: 'That file is not a .geojson or .json file.',
    imported: 'Cadastre imported',
    failed: 'The import failed.',
    parcelsImported: 'Parcels imported',
    linesImported: 'Boundary lines',
    parcelsSkipped: 'Skipped as invalid',
    reloadMapHint: 'Reopen the map to see the new layer.',
  },
  users: {
    title: 'Users & roles',
    description: 'Staff accounts and what each of them may do.',
    heading: 'Accounts',
    hint: 'Everyone who can sign in to the admin portal.',
    addAccount: 'Add new account',
    search: 'Search by name or email…',
    colName: 'Name',
    colEmail: 'Email',
    colRole: 'Role',
    colStatus: 'Status',
    colActions: 'Actions',
    statusActive: 'Active',
    statusSuspended: 'Suspended',
    suspend: 'Suspend',
    reactivate: 'Reactivate',
    empty: 'No accounts yet.',
    emptySearch: 'No accounts match your search.',
    loadError: 'Could not load accounts.',
    rolesHeading: 'Available roles',
    rolesHint: 'What the holder of each role can do in the system.',
    roleUnavailable: 'Not available yet',
    roleUnavailableHint:
      'This role does not exist in the database yet — adding it needs a migration and a decision about its permissions on the server.',
    roleNames: {
      admin: 'Administrator',
      collector: 'Collector',
      accountant: 'Accountant',
      inspector: 'Field inspector',
      clerk: 'Clerk',
      auditor: 'Auditor',
    },
    roleDuties: {
      admin: 'Full access: final approval, settings, and account management.',
      collector: 'Collects fees and registers payments, without editing the register.',
      accountant: 'Issues fees, confirms payments, and follows up on collection.',
      inspector: 'Reviews claims in the field, without access to the activity log.',
      clerk: 'Enters and updates citizen records, without deciding claims.',
      auditor: 'Reads, reviews, and exports data, without final approval.',
    },
    newAccount: 'Create a new account',
    newAccountHint: 'The holder can sign in as soon as it is created.',
    firstName: 'First name',
    lastName: 'Last name',
    email: 'Email',
    password: 'Password',    passwordHint: 'At least eight characters. Deliver it securely to the employee.',
    role: 'Role',
    create: 'Create account',
    creating: 'Creating…',
    created: 'Account created.',
    createFailed: 'Could not create the account.',
    statusChanged: 'Account status updated.',
    incomplete: 'Fill in the required fields.',
  },
};

/**
 * The bundle for a route's `[locale]` segment.
 *
 * Anything that is not `en` falls back to Arabic rather than throwing: the
 * segment is user-editable in the URL, and a mistyped locale should render the
 * portal's primary language, not a crash.
 */
export function settingsCopy(locale: string): SettingsCopy {
  return locale === 'en' ? EN : AR;
}

/** True when the given route locale reads right-to-left. */
export function isRtlLocale(locale: string): boolean {
  return locale !== 'en';
}
