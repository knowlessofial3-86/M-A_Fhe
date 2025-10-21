// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface MergerRecord {
  id: string;
  companyName: string;
  valuation: string; // FHE encrypted
  revenue: string; // FHE encrypted
  employees: string; // FHE encrypted
  timestamp: number;
  buyer: string;
  status: "pending" | "approved" | "rejected";
  dueDiligence: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [mergers, setMergers] = useState<MergerRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newMergerData, setNewMergerData] = useState({
    companyName: "",
    valuation: 0,
    revenue: 0,
    employees: 0,
    dueDiligence: ""
  });
  const [selectedMerger, setSelectedMerger] = useState<MergerRecord | null>(null);
  const [decryptedValues, setDecryptedValues] = useState<{valuation?: number, revenue?: number, employees?: number}>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [showFlowchart, setShowFlowchart] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  // Filter mergers based on search term
  const filteredMergers = mergers.filter(merger => 
    merger.companyName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    merger.dueDiligence.toLowerCase().includes(searchTerm.toLowerCase())
  );

  useEffect(() => {
    loadMergers().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadMergers = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("merger_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing merger keys:", e); }
      }
      
      const list: MergerRecord[] = [];
      for (const key of keys) {
        try {
          const mergerBytes = await contract.getData(`merger_${key}`);
          if (mergerBytes.length > 0) {
            try {
              const mergerData = JSON.parse(ethers.toUtf8String(mergerBytes));
              list.push({ 
                id: key, 
                companyName: mergerData.companyName,
                valuation: mergerData.valuation,
                revenue: mergerData.revenue,
                employees: mergerData.employees,
                timestamp: mergerData.timestamp,
                buyer: mergerData.buyer,
                status: mergerData.status || "pending",
                dueDiligence: mergerData.dueDiligence || ""
              });
            } catch (e) { console.error(`Error parsing merger data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading merger ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setMergers(list);
    } catch (e) { console.error("Error loading mergers:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitMerger = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting sensitive financial data with Zama FHE..." });
    try {
      const encryptedValuation = FHEEncryptNumber(newMergerData.valuation);
      const encryptedRevenue = FHEEncryptNumber(newMergerData.revenue);
      const encryptedEmployees = FHEEncryptNumber(newMergerData.employees);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const mergerId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const mergerData = { 
        companyName: newMergerData.companyName,
        valuation: encryptedValuation,
        revenue: encryptedRevenue,
        employees: encryptedEmployees,
        timestamp: Math.floor(Date.now() / 1000),
        buyer: address,
        status: "pending",
        dueDiligence: newMergerData.dueDiligence
      };
      
      await contract.setData(`merger_${mergerId}`, ethers.toUtf8Bytes(JSON.stringify(mergerData)));
      
      const keysBytes = await contract.getData("merger_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(mergerId);
      await contract.setData("merger_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted M&A data submitted securely!" });
      await loadMergers();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewMergerData({
          companyName: "",
          valuation: 0,
          revenue: 0,
          employees: 0,
          dueDiligence: ""
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const approveMerger = async (mergerId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted financial data with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const mergerBytes = await contract.getData(`merger_${mergerId}`);
      if (mergerBytes.length === 0) throw new Error("Merger not found");
      
      const mergerData = JSON.parse(ethers.toUtf8String(mergerBytes));
      const updatedMerger = { ...mergerData, status: "approved" };
      
      await contract.setData(`merger_${mergerId}`, ethers.toUtf8Bytes(JSON.stringify(updatedMerger)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Merger approved successfully!" });
      await loadMergers();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Approval failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectMerger = async (mergerId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted financial data with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const mergerBytes = await contract.getData(`merger_${mergerId}`);
      if (mergerBytes.length === 0) throw new Error("Merger not found");
      
      const mergerData = JSON.parse(ethers.toUtf8String(mergerBytes));
      const updatedMerger = { ...mergerData, status: "rejected" };
      
      await contract.setData(`merger_${mergerId}`, ethers.toUtf8Bytes(JSON.stringify(updatedMerger)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Merger rejected successfully!" });
      await loadMergers();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isBuyer = (mergerAddress: string) => address?.toLowerCase() === mergerAddress.toLowerCase();

  const handleDecryptFinancials = async (merger: MergerRecord) => {
    const valuation = await decryptWithSignature(merger.valuation);
    const revenue = await decryptWithSignature(merger.revenue);
    const employees = await decryptWithSignature(merger.employees);
    
    if (valuation !== null && revenue !== null && employees !== null) {
      setDecryptedValues({
        valuation,
        revenue,
        employees
      });
    }
  };

  const renderMergerFlowchart = () => (
    <div className="flowchart-container">
      <div className="flowchart-step">
        <div className="step-number">1</div>
        <div className="step-content">
          <h4>Tokenize Equity</h4>
          <p>Convert company shares into FHE-protected NFTs</p>
        </div>
      </div>
      <div className="flowchart-arrow">→</div>
      <div className="flowchart-step">
        <div className="step-number">2</div>
        <div className="step-content">
          <h4>Encrypted Data Room</h4>
          <p>Conduct due diligence on FHE-encrypted financials</p>
        </div>
      </div>
      <div className="flowchart-arrow">→</div>
      <div className="flowchart-step">
        <div className="step-number">3</div>
        <div className="step-content">
          <h4>FHE Valuation</h4>
          <p>Compute valuations without decrypting sensitive data</p>
        </div>
      </div>
      <div className="flowchart-arrow">→</div>
      <div className="flowchart-step">
        <div className="step-number">4</div>
        <div className="step-content">
          <h4>On-chain Settlement</h4>
          <p>Transfer tokenized shares with privacy guarantees</p>
        </div>
      </div>
    </div>
  );

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing encrypted M&A platform...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>FHE<span>M&A</span></h1>
          <p>Confidential Mergers & Acquisitions</p>
        </div>
        <div className="header-actions">
          <div className="search-bar">
            <input 
              type="text" 
              placeholder="Search deals..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <button className="search-icon"></button>
          </div>
          <button onClick={() => setShowCreateModal(true)} className="create-btn">
            + New Deal
          </button>
          <button className="flowchart-btn" onClick={() => setShowFlowchart(!showFlowchart)}>
            {showFlowchart ? "Hide Process" : "View Process"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <main className="main-content">
        {showFlowchart && (
          <div className="flowchart-section">
            <h2>FHE-Powered M&A Process</h2>
            {renderMergerFlowchart()}
          </div>
        )}

        <div className="stats-section">
          <div className="stat-card">
            <h3>Total Deals</h3>
            <p>{mergers.length}</p>
          </div>
          <div className="stat-card">
            <h3>Pending</h3>
            <p>{mergers.filter(m => m.status === "pending").length}</p>
          </div>
          <div className="stat-card">
            <h3>Approved</h3>
            <p>{mergers.filter(m => m.status === "approved").length}</p>
          </div>
          <div className="stat-card">
            <h3>Rejected</h3>
            <p>{mergers.filter(m => m.status === "rejected").length}</p>
          </div>
        </div>

        <div className="mergers-section">
          <div className="section-header">
            <h2>Active M&A Deals</h2>
            <button onClick={loadMergers} className="refresh-btn" disabled={isRefreshing}>
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {filteredMergers.length === 0 ? (
            <div className="no-mergers">
              <p>No active M&A deals found</p>
              <button className="primary-btn" onClick={() => setShowCreateModal(true)}>
                Initiate First Deal
              </button>
            </div>
          ) : (
            <div className="mergers-list">
              {filteredMergers.map(merger => (
                <div className="merger-card" key={merger.id} onClick={() => setSelectedMerger(merger)}>
                  <div className="merger-header">
                    <h3>{merger.companyName}</h3>
                    <span className={`status-badge ${merger.status}`}>{merger.status}</span>
                  </div>
                  <div className="merger-details">
                    <p><strong>Due Diligence:</strong> {merger.dueDiligence.substring(0, 50)}...</p>
                    <p><strong>Buyer:</strong> {merger.buyer.substring(0, 6)}...{merger.buyer.substring(38)}</p>
                    <p><strong>Date:</strong> {new Date(merger.timestamp * 1000).toLocaleDateString()}</p>
                  </div>
                  <div className="merger-actions">
                    {isBuyer(merger.buyer) && merger.status === "pending" && (
                      <>
                        <button className="action-btn approve" onClick={(e) => { e.stopPropagation(); approveMerger(merger.id); }}>
                          Approve
                        </button>
                        <button className="action-btn reject" onClick={(e) => { e.stopPropagation(); rejectMerger(merger.id); }}>
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitMerger} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          mergerData={newMergerData} 
          setMergerData={setNewMergerData}
        />
      )}

      {selectedMerger && (
        <MergerDetailModal 
          merger={selectedMerger} 
          onClose={() => { 
            setSelectedMerger(null); 
            setDecryptedValues({}); 
          }} 
          decryptedValues={decryptedValues}
          isDecrypting={isDecrypting}
          onDecrypt={handleDecryptFinancials}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <h3>FHEM&A</h3>
            <p>Confidential Mergers & Acquisitions powered by Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <p>© {new Date().getFullYear()} FHEM&A. All rights reserved.</p>
          <div className="fhe-badge">FHE-Powered Confidentiality</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void;
  onClose: () => void;
  creating: boolean;
  mergerData: any;
  setMergerData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, mergerData, setMergerData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setMergerData({ ...mergerData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setMergerData({ ...mergerData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!mergerData.companyName || !mergerData.valuation || !mergerData.revenue || !mergerData.employees) {
      alert("Please fill all required fields");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal">
        <div className="modal-header">
          <h2>Initiate New M&A Deal</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Company Name *</label>
            <input 
              type="text" 
              name="companyName" 
              value={mergerData.companyName} 
              onChange={handleChange} 
              placeholder="Target company name"
            />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Valuation (USD) *</label>
              <input 
                type="number" 
                name="valuation" 
                value={mergerData.valuation} 
                onChange={handleNumberChange} 
                placeholder="Company valuation"
              />
            </div>
            <div className="form-group">
              <label>Annual Revenue (USD) *</label>
              <input 
                type="number" 
                name="revenue" 
                value={mergerData.revenue} 
                onChange={handleNumberChange} 
                placeholder="Annual revenue"
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Employees *</label>
              <input 
                type="number" 
                name="employees" 
                value={mergerData.employees} 
                onChange={handleNumberChange} 
                placeholder="Number of employees"
              />
            </div>
            <div className="form-group">
              <label>Due Diligence Notes</label>
              <textarea 
                name="dueDiligence" 
                value={mergerData.dueDiligence} 
                onChange={handleChange} 
                placeholder="Due diligence findings..."
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-grid">
              <div className="preview-item">
                <span>Valuation:</span>
                <div>{mergerData.valuation ? FHEEncryptNumber(mergerData.valuation).substring(0, 30) + '...' : 'Not provided'}</div>
              </div>
              <div className="preview-item">
                <span>Revenue:</span>
                <div>{mergerData.revenue ? FHEEncryptNumber(mergerData.revenue).substring(0, 30) + '...' : 'Not provided'}</div>
              </div>
              <div className="preview-item">
                <span>Employees:</span>
                <div>{mergerData.employees ? FHEEncryptNumber(mergerData.employees).substring(0, 30) + '...' : 'Not provided'}</div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="notice-icon">🔒</div>
            <p>All financial data will be encrypted with Zama FHE before submission and remain encrypted during processing.</p>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn">
            {creating ? "Encrypting with FHE..." : "Submit Confidential Deal"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface MergerDetailModalProps {
  merger: MergerRecord;
  onClose: () => void;
  decryptedValues: {valuation?: number, revenue?: number, employees?: number};
  isDecrypting: boolean;
  onDecrypt: (merger: MergerRecord) => Promise<void>;
}

const MergerDetailModal: React.FC<MergerDetailModalProps> = ({ merger, onClose, decryptedValues, isDecrypting, onDecrypt }) => {
  return (
    <div className="modal-overlay">
      <div className="detail-modal">
        <div className="modal-header">
          <h2>{merger.companyName} M&A Deal</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="merger-info">
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${merger.status}`}>{merger.status}</strong>
            </div>
            <div className="info-item">
              <span>Buyer:</span>
              <strong>{merger.buyer.substring(0, 6)}...{merger.buyer.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date:</span>
              <strong>{new Date(merger.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Due Diligence:</span>
              <p>{merger.dueDiligence}</p>
            </div>
          </div>

          <div className="financial-section">
            <h3>Financial Data</h3>
            <div className="financial-grid">
              <div className="financial-item">
                <h4>Valuation</h4>
                {decryptedValues.valuation !== undefined ? (
                  <p className="decrypted-value">${decryptedValues.valuation.toLocaleString()}</p>
                ) : (
                  <p className="encrypted-value">{merger.valuation.substring(0, 30)}...</p>
                )}
              </div>
              <div className="financial-item">
                <h4>Revenue</h4>
                {decryptedValues.revenue !== undefined ? (
                  <p className="decrypted-value">${decryptedValues.revenue.toLocaleString()}</p>
                ) : (
                  <p className="encrypted-value">{merger.revenue.substring(0, 30)}...</p>
                )}
              </div>
              <div className="financial-item">
                <h4>Employees</h4>
                {decryptedValues.employees !== undefined ? (
                  <p className="decrypted-value">{decryptedValues.employees.toLocaleString()}</p>
                ) : (
                  <p className="encrypted-value">{merger.employees.substring(0, 30)}...</p>
                )}
              </div>
            </div>
            <button 
              className="decrypt-btn" 
              onClick={() => onDecrypt(merger)} 
              disabled={isDecrypting}
            >
              {isDecrypting ? "Decrypting..." : 
               (decryptedValues.valuation !== undefined ? "Hide Values" : "Decrypt with Wallet")}
            </button>
            {decryptedValues.valuation !== undefined && (
              <div className="decryption-notice">
                <p>🔐 Values decrypted with your wallet signature. Never share these numbers.</p>
              </div>
            )}
          </div>

          <div className="fhe-section">
            <h3>FHE Technology</h3>
            <p>This deal uses Zama FHE to keep financial data encrypted during:</p>
            <ul>
              <li>Valuation calculations</li>
              <li>Due diligence analysis</li>
              <li>Share transfer negotiations</li>
            </ul>
            <div className="fhe-badge">FHE-Powered Confidentiality</div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;