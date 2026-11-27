/**
 * /feedback-rewards: the Community Feedback Rewards page, in the home page's look. It shares the
 * header, footer, buttons and section titles with the home page (site.css); its own sections are
 * styled in feedback-rewards.css. Dates, links and the rules' data are in feedbackProgram.ts.
 */
import './feedback-rewards.css'
import { useEffect, type ReactNode } from 'react'
import { DeskNote } from './DeskNote'
import {
  BUG_BOUNTY_URL,
  CATEGORIES,
  EXAMPLE,
  FIRST_ROUND_START,
  LEADERBOARD,
  POINT_VALUES,
  PRIZES,
  REPORT_CHECKLIST,
  ROUND_COUNT,
  ROUND_POOL,
  RULES,
  SUBMIT_URL,
  byRank,
  programState,
  roundPhase,
  roundSpan,
  roundsFrom,
  statusLine,
  submitLinkFor,
  totalPoints,
  type ProgramState,
  type Round,
  type RoundPhase
} from './feedbackProgram'
import { Icon } from './Icon'
import { useReveals, useSpotlight } from './motion'
import { SiteFooter, SiteHeader } from './Site'
import { docsLinkProps, walletLinkProps } from './walletStore'

// The 3D coin the campaign uses (108 × 108)
const COIN = '/shield-and-win/zec-coin.png'

const PHASE_LABEL: Record<RoundPhase, string> = {
  upcoming: 'Upcoming',
  live: 'Open now',
  ended: 'Closed'
}

function External({
  href,
  className,
  children
}: {
  href: string
  className?: string
  children: ReactNode
}) {
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <Icon name="external" className="ext" />
    </a>
  )
}

function Hero({ state, submitUrl }: { state: ProgramState; submitUrl: string | null }) {
  return (
    <section className="fr-hero" aria-labelledby="fr-title">
      <div className="wrap-n fr-hero-grid">
        <div>
          <p className="eyebrow" data-reveal="up">
            Community Feedback Rewards
          </p>
          <h1 id="fr-title" data-reveal="up">
            Report What You Find. <span className="fr-nb">Earn ZEC.</span>
          </h1>
          <p className="fr-lede" data-reveal="up">
            Use Noir Wallet and tell us about the bugs, compatibility and performance problems, and
            rough edges you run into. Every valid report earns points, and each round’s top three
            win ZEC.
          </p>
          <p className={`fr-status is-${state.phase}`} data-reveal="up">
            <i aria-hidden="true" />
            {statusLine(state)}
          </p>
          <div className="cta-row" data-reveal="up">
            {submitUrl ? (
              <External className="btn" href={submitUrl}>
                Submit Feedback
              </External>
            ) : (
              <a className="btn" {...walletLinkProps}>
                <Icon name="download" />
                Install Wallet
              </a>
            )}
            <a className="btn btn-ghost" href="#points">
              How Points Work
            </a>
          </div>
          <p className="fr-note" data-reveal="up">
            This is a product-feedback program, not a security bug bounty. Security issues go to{' '}
            <a href="#security">HackenProof</a>.
          </p>
        </div>
        <PrizeCard />
      </div>
    </section>
  )
}

function PrizeCard() {
  const top = Number(PRIZES[0].amount)
  return (
    <div className="fr-prize fr-panel spot" data-reveal="up">
      <img className="fr-coin" src={COIN} alt="" width={54} height={54} />
      <p className="fr-label">Every round</p>
      <p className="fr-pool">
        <b>{ROUND_POOL}</b> ZEC
      </p>
      <ol className="fr-places">
        {PRIZES.map(prize => (
          <li key={prize.place}>
            <span className="fr-place">{prize.place}</span>
            <span className="fr-bar" aria-hidden="true">
              <i style={{ width: `${(Number(prize.amount) / top) * 100}%` }} />
            </span>
            <span className="fr-amount">
              <b>{prize.amount}</b> ZEC
            </span>
          </li>
        ))}
      </ol>
      <dl className="fr-facts">
        <div>
          <dt>Winners</dt>
          <dd>Top 3 each round</dd>
        </div>
        <div>
          <dt>Round length</dt>
          <dd>2 weeks</dd>
        </div>
        <div>
          <dt>Trial</dt>
          <dd>{ROUND_COUNT} rounds, 1 ZEC in total</dd>
        </div>
      </dl>
    </div>
  )
}

function SectionHead({
  id,
  eyebrow,
  title,
  children
}: {
  id: string
  eyebrow: string
  title: string
  children?: ReactNode
}) {
  return (
    <>
      <p className="eyebrow" data-reveal="up">
        {eyebrow}
      </p>
      <h2 className="h2" id={id} data-reveal="up">
        {title}
      </h2>
      {children && (
        <p className="sec-lede" data-reveal="up">
          {children}
        </p>
      )}
    </>
  )
}

function Schedule({ rounds, now }: { rounds: readonly Round[]; now: Date }) {
  return (
    <section className="fr-sec" id="schedule" aria-labelledby="schedule-title">
      <div className="wrap-n">
        <SectionHead id="schedule-title" eyebrow="Schedule" title="Two Rounds, Four Weeks">
          We’re starting with a two-round trial. Each round is scored on its own: points don’t carry
          over, and you can win in more than one round.
        </SectionHead>
        <ol className="fr-rounds">
          {Array.from({ length: ROUND_COUNT }, (_, index) => {
            const round = rounds[index]
            const phase = round ? roundPhase(round, now) : null
            return (
              <li key={index} className="fr-panel spot" data-reveal="up">
                <span className="fr-round-no">0{index + 1}</span>
                {phase && <span className={`fr-tag is-${phase}`}>{PHASE_LABEL[phase]}</span>}
                <h3>Round {index + 1}</h3>
                <p>{round ? roundSpan(round) : 'Dates to be announced'}</p>
              </li>
            )
          })}
          <li className="fr-after" data-reveal="up">
            <h3>After the trial</h3>
            <p>We’ll look at how both rounds went and decide whether to continue.</p>
          </li>
        </ol>
      </div>
    </section>
  )
}

function Points() {
  return (
    <section className="fr-sec" id="points" aria-labelledby="points-title">
      <div className="wrap-n">
        <SectionHead id="points-title" eyebrow="Points" title="What Your Feedback Is Worth">
          Every valid report earns points for its real value to the product.
        </SectionHead>
        <ul className="fr-points">
          {CATEGORIES.map(category => (
            <li
              key={category.name}
              className={category.points === 0 ? 'is-zero' : undefined}
              data-reveal="up"
            >
              <span className="fr-pts">
                <b>{category.points}</b>
                {category.points === 1 ? ' point' : ' points'}
              </span>
              <h3>{category.name}</h3>
              <p>{category.about}</p>
            </li>
          ))}
        </ul>
        <ul className="fr-notes" data-reveal="up">
          <li>Each report scores in one category only.</li>
          <li>
            Severity follows real impact. A sync problem that makes the wallet’s core features
            unusable can score as a major functional issue: 10 points.
          </li>
          <li>
            Suggestions need a clear use case and real value. They don’t have to be built or shipped
            to count.
          </li>
        </ul>
      </div>
    </section>
  )
}

function Ranking() {
  const ranked = [...EXAMPLE].sort(byRank)
  const totals = ranked.map(entrant => totalPoints(entrant.counts))
  const tied = (total: number) => totals.filter(other => other === total).length > 1
  return (
    <section className="fr-sec" id="ranking" aria-labelledby="ranking-title">
      <div className="wrap-n fr-split">
        <div>
          <SectionHead id="ranking-title" eyebrow="Ranking" title="Quality Beats Volume">
            Points reward the quality of feedback as well as the amount, so sending more reports
            alone won’t win. Each round is ranked by these rules, in order:
          </SectionHead>
          <ol className="fr-order" data-reveal="up">
            <li>Higher total points</li>
            <li>More 10-point reports</li>
            <li>More 5-point reports</li>
            <li>First to reach their final total</li>
          </ol>
          <p className="fr-fine" data-reveal="up">
            Timing comes from when our system recorded each valid report, so how fast we review
            never changes the result.
          </p>
        </div>
        <figure className="fr-example fr-panel" data-reveal="up">
          <figcaption>Example: three people tie on 25 points</figcaption>
          <div className="fr-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">User</th>
                  {POINT_VALUES.map(value => (
                    <th scope="col" key={value}>
                      {value}
                      <span className="fr-unit"> pt{value === 1 ? '' : 's'}</span>
                    </th>
                  ))}
                  <th scope="col">Total</th>
                  <th scope="col">Rank</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((entrant, index) => (
                  <tr key={entrant.user} className={index < 3 ? 'is-winner' : undefined}>
                    <th scope="row">
                      <span className="fr-unit">User </span>
                      {entrant.user}
                    </th>
                    {entrant.counts.map((count, column) => (
                      <td
                        key={column}
                        className={column === 0 && tied(totals[index]) ? 'is-key' : undefined}
                      >
                        {count}
                      </td>
                    ))}
                    <td className="fr-total">{totals[index]}</td>
                    <td className="fr-rank">{index + 1}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            A, B and C all have 25 points, so 10-point reports decide: A has two, B one, C none. D
            sent the most reports (13) but ranks fourth with 23 points.
          </p>
        </figure>
      </div>
    </section>
  )
}

function Rules() {
  return (
    <section className="fr-sec" id="rules" aria-labelledby="rules-title">
      <div className="wrap-n">
        <SectionHead id="rules-title" eyebrow="Fair play" title="What Counts as Valid Feedback" />
        <ol className="fr-rules">
          {RULES.map((rule, index) => (
            <li key={rule.title} className="fr-panel spot" data-reveal="up">
              <span className="fr-rule-no">{String(index + 1).padStart(2, '0')}</span>
              <h3>{rule.title}</h3>
              <p>{rule.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

function Submit({ state, submitUrl }: { state: ProgramState; submitUrl: string | null }) {
  const closedNote =
    state.phase === 'over'
      ? 'The trial has ended, so new feedback no longer counts toward a round.'
      : 'The submission link will be posted here when Round 1 opens.'
  return (
    <section className="fr-sec" id="submit" aria-labelledby="submit-title">
      <div className="wrap-n fr-split">
        <div>
          <SectionHead id="submit-title" eyebrow="Submit" title="How to Send Feedback">
            Send all feedback through the official feedback channel. A good report includes:
          </SectionHead>
          <ul className="fr-checklist" data-reveal="up">
            {REPORT_CHECKLIST.map(item => (
              <li key={item}>
                <Icon name="check" />
                {item}
              </li>
            ))}
          </ul>
          <div className="fr-submit" data-reveal="up">
            {submitUrl ? (
              <External className="btn" href={submitUrl}>
                Submit Feedback
              </External>
            ) : (
              <p className="fr-fine">{closedNote}</p>
            )}
          </div>
        </div>
        <div className="fr-callouts">
          <div className="fr-callout is-warn" data-reveal="up">
            <Icon name="alert" />
            <h3>Never Share Secrets</h3>
            <p>
              Never include your recovery phrase, private keys, wallet password or other sensitive
              information in feedback.
            </p>
          </div>
          <div className="fr-callout is-security" id="security" data-reveal="up">
            <Icon name="shield" />
            <h3>Found a Security Vulnerability?</h3>
            <p>
              Issues involving fund safety, unauthorized transactions or privacy leaks must be
              reported privately through our HackenProof bug bounty. They are not part of this
              program or its ranking.
            </p>
            {BUG_BOUNTY_URL && <External href={BUG_BOUNTY_URL}>Report on HackenProof</External>}
          </div>
        </div>
      </div>
    </section>
  )
}

const REVIEW_STEPS: readonly { title: string; body: ReactNode }[] = [
  {
    title: 'Team review',
    body: 'The Noir Wallet team confirms whether each report is valid and what it scores. Major issues, disputed feedback and the final top three are checked by at least two team members.'
  },
  {
    title: 'Weekly leaderboard',
    body: (
      <>
        Updated every week on X,{' '}
        <a href={LEADERBOARD.href} target="_blank" rel="noopener noreferrer">
          {LEADERBOARD.handle}
        </a>
        . It shows nicknames, valid report counts, points by category and totals, never personal
        details or issues that aren’t fixed yet.
      </>
    )
  },
  {
    title: 'Preliminary ranking',
    body: 'When a round ends, we finish reviewing its feedback and publish a preliminary ranking.'
  },
  {
    title: '48 hours to object',
    body: 'Think something is off? Raise an objection within 48 hours of the preliminary ranking.'
  },
  {
    title: 'Final ranking and payout',
    body: 'Once objections are settled, we publish the final ranking and contact the winners to send their ZEC.'
  }
]

function Review() {
  return (
    <section className="fr-sec" id="review" aria-labelledby="review-title">
      <div className="wrap-n fr-split">
        <div className="fr-split-head">
          <SectionHead id="review-title" eyebrow="Review & payout" title="From Report to Reward">
            The scoring standards and ranking rules stay the same for the whole program.
          </SectionHead>
        </div>
        <ol className="fr-steps">
          {REVIEW_STEPS.map((step, index) => (
            <li key={step.title} data-reveal="up">
              <span className="fr-step-no" aria-hidden="true">
                {index + 1}
              </span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

function Closing({ submitUrl }: { submitUrl: string | null }) {
  return (
    <section className="end fr-end" aria-labelledby="fr-end-title">
      <div className="wrap">
        <h2 id="fr-end-title" data-reveal="up">
          Every Report Makes
          <br />
          Noir Better.
        </h2>
        <div className="cta-row" data-reveal="up">
          <a className="btn" {...walletLinkProps}>
            <Icon name="download" />
            Install Wallet
          </a>
          {submitUrl ? (
            <External className="btn btn-ghost" href={submitUrl}>
              Submit Feedback
            </External>
          ) : (
            <a className="btn btn-ghost" {...docsLinkProps}>
              Docs
              <Icon name="external" className="ext" />
            </a>
          )}
        </div>
        <DeskNote />
      </div>
    </section>
  )
}

export default function FeedbackRewards() {
  useReveals()
  useSpotlight()

  useEffect(() => {
    const previous = document.title
    document.title = 'Community Feedback Rewards · Noir Wallet'
    return () => {
      document.title = previous
    }
  }, [])

  const now = new Date()
  const rounds = roundsFrom(FIRST_ROUND_START)
  const state = programState(rounds, now)
  const submitUrl = submitLinkFor(SUBMIT_URL, state)

  return (
    <>
      <SiteHeader base="/" />
      <main className="fr">
        <Hero state={state} submitUrl={submitUrl} />
        <Schedule rounds={rounds} now={now} />
        <Points />
        <Ranking />
        <Rules />
        <Submit state={state} submitUrl={submitUrl} />
        <Review />
        <Closing submitUrl={submitUrl} />
      </main>
      <SiteFooter statue={false} />
    </>
  )
}
