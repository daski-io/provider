"use strict";

const statusEl = document.getElementById("status");
const button = document.getElementById("connect");

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

button?.addEventListener("click", async () => {
  try {
    if (!window.ethereum) {
      setStatus("No injected wallet (MetaMask) detected.");
      return;
    }
    setStatus("Requesting wallet…");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const address = accounts[0];
    if (!address) {
      setStatus("No wallet account returned.");
      return;
    }
    setStatus("Fetching nonce…");
    const nonceResponse = await fetch("/admin/ui/login/nonce");
    if (!nonceResponse.ok) {
      setStatus("Failed to fetch nonce.");
      return;
    }
    const { nonce, chainId, domain } = await nonceResponse.json();
    const message =
      `${domain} wants you to sign in with your Ethereum account:\n${address}\n\n` +
      "Sign in to the daski provider admin UI.\n\n" +
      `URI: ${window.location.origin}\nVersion: 1\nChain ID: ${chainId}\n` +
      `Nonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
    setStatus("Awaiting signature…");
    const signature = await window.ethereum.request({
      method: "personal_sign",
      params: [message, address],
    });
    setStatus("Verifying signature…");
    const verifyResponse = await fetch("/admin/ui/login/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature }),
    });
    if (!verifyResponse.ok) {
      setStatus(`Verification failed: ${await verifyResponse.text()}`);
      return;
    }
    setStatus("Success. Loading…");
    window.location.assign("/admin/ui/chat");
  } catch (error) {
    setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
  }
});
