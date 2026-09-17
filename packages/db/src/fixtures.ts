import type { Customer, ScenarioId, Snapshot } from '../../core/src/domain.js';

export const demoCustomer: Customer = {
  id: 'cust-acme',
  company: 'Workshop customer',
  name: 'Alex Morgan',
  email: 'alex@workshop.example',
  phone: '+442079460100',
  timezone: 'Asia/Yerevan',
};

/** Templates are deterministic; sessions take copies, never modify global operational data. */
export function scenarioSnapshot(scenario: ScenarioId): Snapshot {
  const snapshot: Snapshot = {
    account: {
      id: 'acct-acme',
      customerId: demoCustomer.id,
      plan: 'Workshop',
      products: ['Relay Workshop'],
      status: 'active',
      balance: 245.5,
    },
  };
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
  if (scenario.startsWith('repair-')) {
    snapshot.account.products = ['Relay Workshop'];
    snapshot.repair = {
      services: [
        {
          id: 'workshop-diagnosis',
          name: 'Workshop diagnosis',
          durationMinutes: 60,
          priceAMD: 5000,
          creditAgainstRepair: true,
          location: 'workshop',
        },
        {
          id: 'home-diagnosis',
          name: 'Home visit and diagnosis in Yerevan',
          durationMinutes: 60,
          priceAMD: 8000,
          creditAgainstRepair: false,
          location: 'home',
        },
      ],
      jobs: [
        {
          id: 'REP-1042',
          customerId: demoCustomer.id,
          appliance: 'washing-machine',
          model: 'Relay Wash W100',
          status: 'awaiting_approval',
          note: 'Diagnosis is complete. Approve the quote with an operator before work begins; repair has not started.',
          estimateAMD: 20000,
          diagnosisCreditAMD: 5000,
          readyAt: null,
        },
      ],
    };
    snapshot.business = {
      services: snapshot.repair.services.map(({ id, name, durationMinutes }) => ({
        id,
        name,
        durationMinutes,
      })),
      orders: [],
    };
  }
  return snapshot;
}
