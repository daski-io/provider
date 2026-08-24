// ServiceRegistry — one entry per (providerAgentId, serviceSlug, version).
export const serviceRegistryAbi = [
  {
    type: "function",
    name: "registerService",
    inputs: [
      { name: "providerAgentId", type: "uint256" },
      { name: "serviceSlug", type: "string" },
      { name: "version", type: "string" },
      { name: "serviceURI", type: "string" },
      { name: "serviceWallet", type: "address" },
    ],
    outputs: [{ name: "serviceId", type: "bytes32" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "computeServiceId",
    inputs: [
      { name: "providerAgentId", type: "uint256" },
      { name: "serviceSlug", type: "string" },
      { name: "version", type: "string" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "exists",
    inputs: [{ name: "serviceId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getService",
    inputs: [{ name: "serviceId", type: "bytes32" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "providerAgentId", type: "uint256" },
        { name: "serviceId", type: "bytes32" },
        { name: "serviceSlug", type: "string" },
        { name: "version", type: "string" },
        { name: "serviceURI", type: "string" },
        { name: "serviceWallet", type: "address" },
        { name: "serviceWalletOwner", type: "address" },
        { name: "serviceWalletAgentWallet", type: "address" },
        { name: "createdAt", type: "uint64" },
        { name: "active", type: "bool" },
      ],
    }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "updateServiceURI",
    inputs: [
      { name: "serviceId", type: "bytes32" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setServiceWallet",
    inputs: [
      { name: "serviceId", type: "bytes32" },
      { name: "newWallet", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "ServiceRegistered",
    inputs: [
      { name: "serviceId", type: "bytes32", indexed: true },
      { name: "providerAgentId", type: "uint256", indexed: true },
      { name: "serviceSlug", type: "string", indexed: false },
      { name: "version", type: "string", indexed: false },
      { name: "serviceURI", type: "string", indexed: false },
      { name: "serviceWallet", type: "address", indexed: false },
    ],
  },
] as const;

// Canonical ERC-8004 Identity Registry reads used by provider authorization.
export const identityRegistryAbi = [
  {
    type: "function",
    name: "ownerOf",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "tokenURI",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getAgentWallet",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;
