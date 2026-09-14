/**
 * Shared domain types. Imported by lib modules, by the function, and by the client,
 * so nothing here may reference node, pg, or React.
 */

export type Role = 'owner' | 'collector';
export type SubscriberStatus = 'active' | 'suspended' | 'disconnected';
export type CycleStatus = 'open' | 'issued' | 'closed';
export type PaidCurrency = 'USD' | 'LBP';
export type ExpenseCategory = 'diesel' | 'maintenance' | 'salary' | 'other';
export type ActorType = 'staff' | 'subscriber' | 'system';
export type NotificationType =
  | 'bill_issued'
  | 'payment_recorded'
  | 'owner_message'
  | 'request_update';
export type ServiceRequestKind =
  | 'meter_issue'
  | 'new_connection'
  | 'disconnect'
  | 'billing_question'
  | 'other';
export type ServiceRequestStatus = 'open' | 'in_progress' | 'resolved' | 'rejected';
export type DeviceStatus = 'active' | 'disabled';
export type Language = 'ar' | 'en';

export interface StaffActor {
  kind: 'staff';
  id: number;
  role: Role;
  name: string;
  username: string;
}

export interface SubscriberActor {
  kind: 'subscriber';
  id: number;
  code: string;
  name: string;
}

export type Actor = StaffActor | SubscriberActor;

export interface Staff {
  id: number;
  username: string;
  name: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
}

export interface Subscriber {
  id: number;
  code: string;
  name: string;
  phone: string | null;
  zone: string | null;
  address: string | null;
  meterSerial: string | null;
  status: SubscriberStatus;
  notes: string | null;
  createdAt: string;
}

export interface SubscriberWithBalance extends Subscriber {
  balanceUsdCents: number;
  billedUsdCents: number;
  paidUsdCents: number;
}

export interface BillingCycle {
  id: number;
  period: string;
  usdPerKwhCents: number;
  lbpRate: number;
  status: CycleStatus;
  openedAt: string;
  issuedAt: string | null;
  closedAt: string | null;
  openedBy: number;
}

export interface CycleProgress {
  cycleId: number;
  period: string;
  status: CycleStatus;
  readingsEntered: number;
  activeSubscribers: number;
}

export interface MeterReading {
  id: number;
  subscriberId: number;
  cycleId: number;
  previousValue: number;
  currentValue: number;
  kwh: number;
  isEstimated: boolean;
  meterReset: boolean;
  readAt: string;
  enteredBy: number;
  note: string | null;
}

export interface RouteRow {
  subscriberId: number;
  code: string;
  name: string;
  zone: string | null;
  meterSerial: string | null;
  previousValue: number;
  currentValue: number | null;
  kwh: number | null;
  isEstimated: boolean | null;
  meterReset: boolean | null;
  note: string | null;
  trailingMeanKwh: number | null;
}

export interface Bill {
  id: number;
  subscriberId: number;
  cycleId: number;
  period: string;
  kwh: number;
  usdPerKwhCents: number;
  amountUsdCents: number;
  lbpRate: number;
  amountLbp: number;
  issuedAt: string;
}

export interface Payment {
  id: number;
  subscriberId: number;
  amountUsdCents: number;
  paidCurrency: PaidCurrency;
  amountLbp: number | null;
  lbpRateUsed: number | null;
  paidAt: string;
  receivedBy: number;
  receivedByName?: string;
  note: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface Expense {
  id: number;
  category: ExpenseCategory;
  amountUsdCents: number;
  liters: number | null;
  vendor: string | null;
  spentAt: string;
  enteredBy: number;
  note: string | null;
}

export interface NotificationItem {
  id: number;
  type: NotificationType;
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
  billId: number | null;
  requestId: number | null;
  readAt: string | null;
  createdAt: string;
}

export interface ServiceRequest {
  id: number;
  subscriberId: number;
  kind: ServiceRequestKind;
  body: string;
  status: ServiceRequestStatus;
  ownerNote: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closedBy: number | null;
}

/** What the owner queue shows: the request plus who filed it, without a second call. */
export interface ServiceRequestWithSubscriber extends ServiceRequest {
  subscriberCode: string;
  subscriberName: string;
  subscriberPhone: string | null;
}

export interface MeterDevice {
  id: number;
  subscriberId: number;
  serial: string;
  status: DeviceStatus;
  installedAt: string;
  lastSeenAt: string | null;
}

/** The owner list: a device plus who it is installed for and what it last said. */
export interface MeterDeviceWithSubscriber extends MeterDevice {
  subscriberCode: string;
  subscriberName: string;
  lastValue: number | null;
  lastTakenAt: string | null;
}

/**
 * What a subscriber can see part-way through a cycle. Nothing here is a bill: the
 * amount is what the reading would come to at the open cycle price, and only a
 * device that has reported can fill it in at all.
 */
export interface LiveUsage {
  period: string | null;
  usdPerKwhCents: number | null;
  lbpRate: number | null;
  previousValue: number | null;
  hasDevice: boolean;
  live: {
    value: number;
    takenAt: string;
    /** null when the meter reads below the last official one: replaced, or rolled over. */
    kwh: number | null;
    amountUsdCents: number | null;
    amountLbp: number | null;
  } | null;
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
