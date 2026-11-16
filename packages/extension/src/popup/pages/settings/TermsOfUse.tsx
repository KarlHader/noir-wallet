import { PageHeader } from '../../components/common/PageHeader'

const TERMS_LAST_UPDATED = '12 May 2026'

const sections = [
  {
    title: '1. About Noir Wallet',
    content: `Noir Wallet is a self-custodial crypto wallet designed to support privacy-preserving on-chain activity.

Noir Wallet may allow users to create, import, and manage self-custodial wallets; send, receive, and manage supported digital assets; use privacy-preserving wallet features; access shielded assets and shielded transactions; express privacy-related transaction intents; interact with NEAR Intents or other intent-based infrastructure; access ZECFi integrations; access cross-chain swaps, bridges, lending protocols, decentralized applications, and other third-party services.

Noir Wallet is software. We do not custody your assets, hold your private keys, control your transactions, guarantee transaction execution, or act as a bank, broker, exchange, financial adviser, investment adviser, or custodian.`
  },
  {
    title: '2. Self-Custody',
    content: `Noir Wallet is always self-custodial.

You are solely responsible for your wallet, private keys, recovery phrase, seed phrase, passwords, devices, and any other credentials used to access your wallet or digital assets.

Ref Labs cannot access, recover, reset, or restore your wallet, private keys, recovery phrase, or digital assets.

If you lose access to your recovery phrase, private key, device, or wallet credentials, you may permanently lose access to your digital assets.

Anyone with access to your recovery phrase or private key may be able to control your wallet and transfer your assets.

Noir Wallet will never ask you for your recovery phrase or private key.`
  },
  {
    title: '3. Wallet-Based Access',
    content: `Noir Wallet is designed to be accessed through wallet-based interactions.

Noir Wallet does not require users to create an account with an email address, phone number, username, or password by default.

If you choose to contact us for support, participate in campaigns, or use optional third-party services, you may voluntarily provide additional information.`
  },
  {
    title: '4. Privacy-Preserving Activity',
    content: `Noir Wallet is designed to support privacy-preserving activity, but we do not guarantee complete anonymity.

Privacy technologies may reduce data exposure, but they may not fully prevent analysis, tracing, inference, metadata collection, network-level monitoring, third-party tracking, or disclosure required by law.

Blockchain networks, RPC providers, indexers, app stores, device providers, analytics tools, infrastructure providers, routing partners, bridges, lending protocols, decentralized applications, or other third-party services may collect or process information according to their own policies.`
  },
  {
    title: '5. Limited Data Collection',
    content: `Noir Wallet is designed to minimize data collection.

We do not collect or store your private keys, recovery phrase, seed phrase, or password. We do not sell user personal data.

We may collect limited technical and usage information to maintain, secure, debug, and improve the Services, including app version, device type, operating system, crash reports, error logs, feature usage, aggregated wallet setup metrics, and support messages you voluntarily send to us.`
  },
  {
    title: '6. Intents, Routing, and Third-Party Infrastructure',
    content: `Noir Wallet may help users express transaction intents or route transactions through third-party infrastructure. These third-party services are not controlled by Ref Labs.

You understand and agree that intents may fail, expire, or execute differently than expected; quotes, routes, prices, rates, fees, and estimated outputs may change; transactions may be delayed, rejected, reverted, or fail.

Your use of third-party services is at your own risk and may be subject to additional terms and privacy policies.`
  },
  {
    title: '7. Digital Asset Risks',
    content: `Digital assets involve significant risk. By using Noir Wallet, you understand and accept that transactions may be irreversible; asset prices may be volatile; digital assets may lose value; blockchain networks may experience congestion, downtime, forks, bugs, attacks, or failures; smart contracts may contain vulnerabilities or be exploited; privacy-preserving technologies may not guarantee complete anonymity; you may lose some or all of your digital assets.

You are solely responsible for reviewing and evaluating any transaction, asset, protocol, route, intent, swap, bridge, lending position, or third-party service before using it.`
  },
  {
    title: '8. No Financial Advice',
    content: `Noir Wallet does not provide financial, investment, legal, tax, trading, or accounting advice.

Any information shown in Noir Wallet is provided for informational purposes only. You are solely responsible for your own decisions and should consult qualified advisers where appropriate.`
  },
  {
    title: '9. Fees',
    content: `Noir Wallet may be free to download and use, but blockchain transactions and third-party services may require fees including network fees, gas fees, protocol fees, bridge fees, swap fees, and other third-party service fees.

Ref Labs may charge or receive fees, spreads, affiliate fees, routing fees, or other compensation in connection with certain features. Where applicable, such fees will be displayed before you confirm a transaction.`
  },
  {
    title: '10. Taxes',
    content: `You are solely responsible for determining and paying any taxes, duties, or reporting obligations that may apply to your use of Noir Wallet, digital assets, transactions, or other on-chain activity. Ref Labs does not provide tax advice.`
  },
  {
    title: '11. Acceptable Use',
    content: `You agree not to use Noir Wallet to violate any applicable law or regulation; engage in fraud, scams, theft, market manipulation, money laundering, terrorist financing, sanctions evasion, or other illegal activity; infringe the rights of Ref Labs, other users, or third parties; attack, disrupt, or interfere with the Services; introduce malware, exploits, or harmful code.

We may restrict, suspend, or discontinue access to parts of the Services if we believe your use creates legal, regulatory, security, operational, or reputational risk.`
  },
  {
    title: '12. Compliance and Sanctions',
    content: `You are responsible for complying with all laws and regulations that apply to your use of Noir Wallet. You may not use Noir Wallet if you are subject to applicable sanctions or located in a jurisdiction where use of the Services is prohibited.`
  },
  {
    title: '13. Service Availability',
    content: `We may update, modify, suspend, restrict, or discontinue Noir Wallet or any part of the Services at any time. We do not guarantee that Noir Wallet will always be available, secure, accurate, uninterrupted, error-free, or compatible with every device, network, asset, protocol, or third-party service.`
  },
  {
    title: '14. Intellectual Property',
    content: `Noir Wallet, including the name, brand, logo, website, app design, interface, software, content, and related materials, is owned by Ref Labs or its licensors. Subject to these Terms, Ref Labs grants you a limited, revocable, non-exclusive, non-transferable license to use the Services for personal or authorized business use.`
  },
  {
    title: '15. Disclaimer',
    content: `Noir Wallet is provided on an "as is" and "as available" basis. To the maximum extent permitted by law, Ref Labs disclaims all warranties, whether express, implied, statutory, or otherwise, including warranties of merchantability, fitness for a particular purpose, title, non-infringement, security, accuracy, availability, and error-free operation.`
  },
  {
    title: '16. Limitation of Liability',
    content: `To the maximum extent permitted by law, Ref Labs and its affiliates will not be liable for any indirect, incidental, special, consequential, punitive, exemplary, or lost-profit damages.

Ref Labs' total liability for any claim relating to the Services will not exceed the greater of (a) the amount you paid directly to Ref Labs in the 12 months before the claim, or (b) USD $100.`
  },
  {
    title: '17. Indemnity',
    content: `You agree to defend, indemnify, and hold harmless Ref Labs and its affiliates from any claims, damages, losses, liabilities, costs, and expenses arising from your use of the Services, your violation of these Terms, or your violation of any law or regulation.`
  },
  {
    title: '18. Termination',
    content: `You may stop using Noir Wallet at any time. Ref Labs may suspend, restrict, or terminate access to the Services at any time if we believe it is necessary for legal, regulatory, security, operational, compliance, or risk reasons.`
  },
  {
    title: '19. Changes to These Terms',
    content: `We may update these Terms from time to time. Your continued use of Noir Wallet after the updated Terms become effective means you accept the updated Terms.`
  },
  {
    title: '20. Governing Law',
    content: `These Terms are governed by the laws of the British Virgin Islands, without regard to conflict of law principles.`
  },
  {
    title: '21. Disputes',
    content: `Any dispute arising out of or relating to these Terms or the Services will be subject to the exclusive jurisdiction of the courts of the British Virgin Islands, unless applicable law requires otherwise.`
  },
  {
    title: '22. Contact',
    content: (
      <>
        If you have questions about these Terms, please contact us at:
        {'\n\n'}Email:{' '}
        <a className="underline" href="mailto:support@zknoir.com">
          support@zknoir.com
        </a>
        {'\n'}Website:{' '}
        <a className="underline" href="http://zknoir.com" target="_blank" rel="noopener noreferrer">
          zknoir.com
        </a>
      </>
    )
  }
]

interface TermsOfUseProps {
  embedded?: boolean
}

export function TermsOfUse({ embedded }: TermsOfUseProps = {}) {
  const content = (
    <>
      <p className="text-xs text-muted mb-4">Last Updated: {TERMS_LAST_UPDATED}</p>

      <p className="text-xs text-muted/80 leading-relaxed mb-4">
        These Terms of Use ("Terms") govern your access to and use of Noir Wallet, including our
        website, mobile application, software, interfaces, and related services. Noir Wallet is
        provided by Ref Labs. By accessing or using Noir Wallet, you agree to these Terms.
      </p>

      <div className="space-y-4">
        {sections.map((section, index) => (
          <div key={index}>
            <h3 className="text-xs font-semibold mb-1.5">{section.title}</h3>
            <p className="text-xs text-muted/80 leading-relaxed whitespace-pre-line">
              {section.content}
            </p>
          </div>
        ))}
      </div>
    </>
  )

  if (embedded) {
    return (
      <div className="max-h-[460px] overflow-y-auto px-1 py-2">
        <h2 className="text-base font-semibold mb-3">Terms of Use</h2>
        {content}
      </div>
    )
  }

  return (
    <div className="page-container">
      <PageHeader title="Terms of Use" showBack />
      <div className="flex-1 overflow-y-auto px-5 py-4">{content}</div>
    </div>
  )
}
