import type { Customer, ScenarioId, Snapshot } from '../../core/src/domain.js';

export const demoCustomer: Customer = {
  id: 'cust-acme',
  company: 'Acme Ltd',
  name: 'Alex Morgan',
  email: 'alex@acme.example',
  phone: '+442079460100',
  timezone: 'Europe/London',
};

/** Templates are deterministic; sessions take copies, never modify global operational data. */
export function scenarioSnapshot(scenario: ScenarioId): Snapshot {
  const snapshot: Snapshot = {
    account: {
      id: 'acct-acme',
      customerId: demoCustomer.id,
      plan: 'Business',
      products: ['SIP Trunking'],
      status: 'active',
      balance: 245.5,
      internationalEnabled: true,
      ukEnabled: true,
    },
    trunk: {
      id: 'trunk-acme-london',
      customerId: demoCustomer.id,
      name: 'London PBX',
      registered: true,
      credentialsValid: true,
      callerIdVerified: true,
      callerId: '+442079460100',
      region: 'UK',
      credentialVersion: 1,
    },
    number: {
      id: 'num-acme-uk',
      customerId: demoCustomer.id,
      number: '+442079460100',
      route: 'trunk-acme-london',
      enabled: true,
    },
    calls: Array.from({ length: 8 }, (_, index) => ({
      id: `call-acme-${String(index + 1).padStart(3, '0')}`,
      customerId: demoCustomer.id,
      startedAt: `2026-09-15T${index < 3 ? '08' : '09'}:${String(index * 6).padStart(2, '0')}:00.000Z`,
      from: '+442079460100',
      to: index % 2 ? '+442079460200' : '+441614960100',
      direction: 'outbound' as const,
      status: index < 3 ? ('completed' as const) : ('failed' as const),
      sipCode: index < 3 ? 200 : 403,
      durationSec: index < 3 ? 90 + index * 30 : 0,
      trunkId: 'trunk-acme-london',
      carrier: 'Relay UK partner A',
    })),
    incidents: [],
  };
  switch (scenario) {
    case 'carrier-incident':
      snapshot.incidents.push({
        id: 'INC-UK-20260915',
        title: 'UK outbound carrier degradation',
        region: 'UK',
        status: 'investigating',
        startedAt: '2026-09-15T09:00:00.000Z',
        description:
          'Partner A is rejecting a subset of UK outbound calls with SIP 403. Engineering is investigating. No confirmed restoration time.',
      });
      break;
    case 'caller-id':
      snapshot.trunk.callerIdVerified = false;
      snapshot.trunk.callerId = '+442079460999';
      snapshot.calls.slice(3).forEach((call) => {
        call.from = snapshot.trunk.callerId;
      });
      break;
    case 'international-disabled':
      snapshot.account.internationalEnabled = false;
      break;
    case 'invalid-credentials':
      snapshot.trunk.credentialsValid = false;
      snapshot.trunk.registered = false;
      break;
    case 'account-balance':
      snapshot.account.balance = -8.25;
      snapshot.account.status = 'restricted';
      break;
    case 'number-routing':
      snapshot.number.route = null;
      snapshot.calls.slice(3).forEach((call) => {
        call.direction = 'inbound';
        call.to = snapshot.number.number;
        call.from = '+442079460200';
        call.sipCode = 404;
      });
      break;
    case 'unknown':
      snapshot.calls.slice(3).forEach((call) => {
        call.sipCode = 503;
      });
      break;
  }
  if (['appointment-booking', 'lead-qualification', 'order-support'].includes(scenario)) {
    snapshot.account.products = [scenario === 'order-support' ? 'Demo store' : 'Consulting'];
    snapshot.business = {
      services: [
        { id: 'consultation', name: 'Discovery consultation', durationMinutes: 30 },
        { id: 'implementation', name: 'Implementation planning', durationMinutes: 60 },
      ],
      orders: [
        {
          id: 'ORD-1042',
          customerId: demoCustomer.id,
          items: ['Wireless headset'],
          status: 'processing',
          deliveryAddress: '10 King Street, London',
          estimatedDelivery: 'Within 3 business days (fictional demo order)',
        },
      ],
    };
  }
  return snapshot;
}
