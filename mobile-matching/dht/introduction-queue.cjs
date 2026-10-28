'use strict';
const crypto = require('hypercore-crypto');
const b4a = require('b4a');
const nonce = () => b4a.toString(crypto.randomBytes(16), 'hex');
const keyOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requestOK = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

// Only unfinished introductions live here. No board, moves, seat tokens or saves.
class IntroductionQueue {
  constructor(options = {}) {
    this.capacity = options.capacity ?? 100;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 2 || this.capacity > 10000) throw new Error('Invalid queue capacity');
    this.now = options.now || Date.now;
    this.ttl = options.ttl ?? 45000;
    this.players = new Map();
    this.tickets = new Map();
    this.order = 0;
  }
  join(id, request, gameKey) {
    if (!keyOK(id) || !keyOK(gameKey) || !requestOK(request)) return { status: 'invalid' };
    const existing = this.players.get(id);
    if (existing) {
      if (existing.request !== request || existing.gameKey !== gameKey) return { status: 'busy' };
      existing.seen = this.now();
      return { status: existing.ticket ? 'connecting' : 'waiting', ticket: existing.ticket };
    }
    if (this.players.size >= this.capacity) return { status: 'full' };
    this.players.set(id, { id, request, gameKey, order: ++this.order, seen: this.now(), ticket: '' });
    return { status: 'waiting' };
  }
  pair() {
    const waiting = [...this.players.values()].filter(player => !player.ticket).sort((a, b) => a.order - b.order);
    const created = [];
    while (waiting.length > 1) {
      const a = waiting.shift(), b = waiting.shift();
      const ticket = { id: nonce(), topic: b4a.toString(crypto.randomBytes(32), 'hex'),
        players: [a, b].map(({ id, request, gameKey }) => ({ id, request, gameKey })),
        expires: this.now() + this.ttl, confirmed: new Set() };
      a.ticket = b.ticket = ticket.id;
      this.tickets.set(ticket.id, ticket);
      created.push(this.publicTicket(ticket));
    }
    return created;
  }
  publicTicket(ticket) {
    return { id: ticket.id, topic: ticket.topic, players: ticket.players, expires: ticket.expires };
  }
  confirm(id, request, ticketId) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || !ticket.players.some(player => player.id === id && player.request === request)) return false;
    ticket.confirmed.add(id);
    const player = this.players.get(id);
    if (player?.request === request && player.ticket === ticketId) this.players.delete(id);
    if (ticket.confirmed.size === 2) this.tickets.delete(ticketId);
    return true;
  }
  cancel(id, request) {
    const player = this.players.get(id);
    if (!player || player.request !== request) return [];
    if (!player.ticket) { this.players.delete(id); return []; }
    const ticket = this.tickets.get(player.ticket);
    this.players.delete(id);
    if (!ticket) return [];
    this.tickets.delete(ticket.id);
    for (const participant of ticket.players) {
      const current = this.players.get(participant.id);
      if (current?.ticket === ticket.id) this.players.delete(participant.id);
    }
    return [this.publicTicket(ticket)];
  }
  expire() {
    const expired = [];
    const now = this.now();
    for (const ticket of this.tickets.values()) {
      if (now < ticket.expires) continue;
      this.tickets.delete(ticket.id);
      for (const participant of ticket.players) {
        const current = this.players.get(participant.id);
        if (current?.ticket === ticket.id) this.players.delete(participant.id);
      }
      expired.push(this.publicTicket(ticket));
    }
    for (const [id, player] of this.players) if (!player.ticket && now - player.seen > this.ttl) this.players.delete(id);
    return expired;
  }
  clear() { this.players.clear(); this.tickets.clear(); }
}
module.exports = { IntroductionQueue, keyOK, requestOK };

