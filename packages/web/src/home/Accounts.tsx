/**
 * Choose How Visible Each Move Is (design mock): the three accounts every wallet has, side by
 * side. Each column has the account's card peeking out over its top edge (the Public card is
 * tilted), what the account is for, then who can see it and when to use it.
 */
import { ACCOUNTS } from './content'

export function Accounts() {
  return (
    <section className="sec-n accounts" aria-labelledby="accounts-title">
      <div className="wrap-n">
        <p className="eyebrow" data-reveal="up">
          Noir Wallet Types
        </p>
        <h2 className="h2" id="accounts-title" data-reveal="up">
          Choose How Visible Each Move Is
        </h2>
        <p className="sec-lede" data-reveal="up">
          Every Noir wallet has three accounts. Each one has its own job, and each shows a different
          amount to the outside world.
        </p>
        <ul className="acct-grid">
          {ACCOUNTS.map(account => (
            <li key={account.id} className={`acct acct-${account.id}`} data-reveal="up">
              <div className="acct-card" aria-hidden="true">
                <i className="acct-dot" />
                <span className="acct-name">{account.name}</span>
                <span className="acct-amount">
                  $<i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              </div>
              <div className="acct-body spot">
                <h3>{account.name}</h3>
                <div className="acct-about">
                  <p>{account.intro}</p>
                  <p className="acct-detail">{account.detail}</p>
                </div>
                <dl>
                  <dt>Who can see it</dt>
                  <dd>{account.who}</dd>
                  <dt>Use it when</dt>
                  <dd>{account.when}</dd>
                </dl>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
