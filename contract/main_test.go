package main

import (
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

func TestStateKeysAreChainMakerCompatible(t *testing.T) {
	allowed := regexp.MustCompile(`^[A-Za-z0-9._-]{1,1024}$`)
	keys := []string{
		tokenKey("山海之间-001"),
		historyCountKey("山海之间-001"),
		historyKey("山海之间-001", 25),
		balanceKey("org@alice"),
		operatorKey("org@alice", "org@bob"),
		tokenIndexKey(25),
		eventKey(25),
	}
	for _, key := range keys {
		if !allowed.MatchString(key) { t.Fatalf("invalid state key: %q", key) }
	}
	if tokenKey("作品 A") == tokenKey("作品 B") { t.Fatal("distinct IDs share a key") }
}

func TestBatchMetadataAcceptsCMNFAByteEncoding(t *testing.T) {
	const metadata = `{"name":"山海之间","image":"https://example.com/art.svg"}`
	encoded, err := json.Marshal(base64.StdEncoding.EncodeToString([]byte(metadata)))
	if err != nil { t.Fatal(err) }
	decoded, err := metadataFromBatch(encoded)
	if err != nil || string(decoded) != metadata { t.Fatalf("decoded metadata: %q, %v", decoded, err) }
	raw, err := metadataFromBatch(json.RawMessage(metadata))
	if err != nil || string(raw) != metadata { t.Fatalf("raw metadata: %q, %v", raw, err) }
}

func TestHashValidationAndRawMetadataDigest(t *testing.T) {
	const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if actual := sha256Hex([]byte("abc")); actual != abc { t.Fatalf("SHA-256 mismatch: %s", actual) }
	got, err := normalizedHash(strings.ToUpper(abc), true)
	if err != nil || got != abc { t.Fatalf("hash normalization failed: %q, %v", got, err) }
	if _, err := normalizedHash(strings.Repeat("a", 63), true); err == nil { t.Fatal("short hash accepted") }
	if _, err := normalizedHash("", true); err == nil { t.Fatal("missing hash accepted") }
	if got, err := normalizedHash("", false); err != nil || got != "" { t.Fatal("optional hash rejected") }
}

func TestClearingListingRetainsNonce(t *testing.T) {
	token := Token{Listed: true, Price: 50, ExpiryHeight: 100, OrderNonce: 7}
	clearListing(&token)
	if token.Listed || token.Price != 0 || token.ExpiryHeight != 0 || token.OrderNonce != 7 {
		t.Fatalf("unexpected token after listing clear: %+v", token)
	}
}

func TestApprovalFlagAcceptsOldAndStandardInputs(t *testing.T) {
	for input, want := range map[string]string{"1":"1", "0":"0", "true":"1", "false":"0"} {
		got, err := approvalFlag(input)
		if err != nil || got != want { t.Fatalf("flag %q: %q, %v", input, got, err) }
	}
	if _, err := approvalFlag("yes"); err == nil { t.Fatal("invalid flag accepted") }
}
