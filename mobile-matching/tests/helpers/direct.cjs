'use strict';
async function localIce(context) {
  await context.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native { constructor(options) { super({ ...options, iceServers: [] }); } };
  });
}
async function directFixture(page, state) {
  await page.evaluate(state => {
    const Native = window.StrangeChessDirect.Link;
    window.StrangeChessDirect.Link = class extends Native {
      constructor(options = {}) { super({ ...options, initialStateFactory: () => JSON.parse(JSON.stringify(state)) }); }
    };
  }, state);
}
async function pair(host, guest, nativeShare = false) {
  await host.locator('#onlineModeBtn').click(); await host.locator('#directCreateBtn').click();
  await host.waitForFunction(() => document.querySelector('#directInviteOutput').value.startsWith('SC-DIRECT-1:'));
  const offer = await host.locator('#directInviteOutput').inputValue();
  if (nativeShare) await guest.evaluate(text => window.receiveNativeInvite(text), offer);
  else { await guest.locator('#onlineModeBtn').click(); await guest.locator('#inviteInput').fill(offer); }
  await guest.locator('#joinInviteBtn').click();
  await guest.waitForFunction(() => document.querySelector('#directInviteOutput').value.startsWith('SC-DIRECT-1:'));
  const answer = await guest.locator('#directInviteOutput').inputValue();
  await host.locator('#inviteInput').fill(answer); await host.locator('#joinInviteBtn').click();
  for (const page of [host, guest]) await page.waitForFunction(() => document.querySelector('#roomStatusText').textContent.includes('对局进行中'));
  return { offer, answer };
}
module.exports = { localIce, directFixture, pair };
