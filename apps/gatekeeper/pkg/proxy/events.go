package proxy

import (
	"context"
	"sync"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// subscriberBuffer is how many events a slow subscriber may fall behind by
// before the bus starts dropping them.
//
// Dropping is safe because a snapshot is always the *whole* state (see
// [status.EventSnapshot]): a dashboard that missed one is corrected by the next
// one a second later. Blocking instead would let a stalled terminal hold up the
// endpoint goroutine that published the event, which is the data path.
const subscriberBuffer = 64

// bus fans one supervisor's events out to every live subscriber.
type bus struct {
	mu     sync.Mutex
	next   int
	subs   map[int]chan status.Event
	closed bool
}

func newBus() *bus { return &bus{subs: map[int]chan status.Event{}} }

// subscribe returns a channel of events that is closed when ctx is done or the
// bus shuts down.
func (b *bus) subscribe(ctx context.Context) <-chan status.Event {
	ch := make(chan status.Event, subscriberBuffer)

	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		close(ch)
		return ch
	}
	id := b.next
	b.next++
	b.subs[id] = ch
	b.mu.Unlock()

	go func() {
		<-ctx.Done()
		b.unsubscribe(id)
	}()
	return ch
}

func (b *bus) unsubscribe(id int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if ch, ok := b.subs[id]; ok {
		delete(b.subs, id)
		close(ch)
	}
}

// publish delivers an event to every subscriber that can take it now.
func (b *bus) publish(event status.Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, ch := range b.subs {
		select {
		case ch <- event:
		default: // a subscriber that cannot keep up loses this event, not the next
		}
	}
}

// close ends every subscription.
func (b *bus) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	for id, ch := range b.subs {
		delete(b.subs, id)
		close(ch)
	}
}

// log publishes one line of the dashboard's live tail.
func (b *bus) log(at time.Time, level, endpoint, message string) {
	line := status.LogLine{At: at, Level: level, Endpoint: endpoint, Message: message}
	b.publish(status.Event{Kind: status.EventLog, Log: &line})
}
